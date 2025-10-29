import React, { useReducer, useCallback, useRef, useEffect } from 'react';
import { Task, Role, AppState, Action } from './types';
import { createChat, sendMessage, sendMessageStream } from './services/geminiService';
import { parseFile } from './utils/fileParser';
import { DataUpload } from './components/DataUpload';
import { DataPreview } from './components/DataPreview';
import { BotIcon, UploadCloudIcon, SendIcon, PlusIcon, SpinnerIcon } from './components/Icons';
import { ChatMessage } from './components/ChatMessage';
import { SuggestionChips } from './components/SuggestionChips';
import { Chat } from '@google/genai';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const initialState: AppState = {
  file: null,
  parsedData: null,
  rawData: null,
  userQuery: '',
  isLoading: false,
  error: null,
  chat: null,
  chatHistory: [],
};

function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'START_LOADING':
      return { ...state, isLoading: true, error: null };
    case 'SET_ERROR':
      return { ...state, isLoading: false, error: action.payload };
    case 'SET_USER_QUERY':
      return { ...state, userQuery: action.payload };
    case 'SET_FILE':
      return { ...state, file: action.payload, parsedData: null, rawData: null, chat: null, chatHistory: [], error: null };
    case 'SET_PARSED_DATA':
      return { ...state, parsedData: action.payload.data, rawData: action.payload.rawData, chat: action.payload.chat };
    case 'ADD_TO_HISTORY':
      return { ...state, chatHistory: [...state.chatHistory, action.payload] };
    case 'UPDATE_LAST_IN_HISTORY':
      const newHistory = [...state.chatHistory];
      if (newHistory.length > 0) {
        const lastMessage = { ...newHistory[newHistory.length - 1] };
        lastMessage.content += action.payload.content;
        lastMessage.isLoading = action.payload.isLoading; // Update loading state
        newHistory[newHistory.length - 1] = lastMessage;
      }
      return { ...state, chatHistory: newHistory };
    case 'FINISH_STREAM':
        const finalHistory = [...state.chatHistory];
        if (finalHistory.length > 0) {
            finalHistory[finalHistory.length - 1].isLoading = false;
        }
        return { ...state, isLoading: false, chatHistory: finalHistory };
    case 'FAIL_LAST_IN_HISTORY':
      const failedHistory = [...state.chatHistory];
      if (failedHistory.length > 0) {
        const lastMessage = { ...failedHistory[failedHistory.length - 1] };
        if (lastMessage.role === Role.MODEL && lastMessage.isLoading) {
          lastMessage.type = 'error';
          lastMessage.content = action.payload;
          lastMessage.isLoading = false;
          failedHistory[failedHistory.length - 1] = lastMessage;
        } else {
            failedHistory.push({ role: Role.MODEL, type: 'error', content: action.payload, isLoading: false });
        }
      } else {
        failedHistory.push({ role: Role.MODEL, type: 'error', content: action.payload, isLoading: false });
      }
      return { ...state, isLoading: false, chatHistory: failedHistory };
    case 'RESET_STATE':
        if (action.payload.keepFile) {
            // "New Chat" button was clicked. Keep file-related state, clear chat history.
            return {
                ...state,
                userQuery: '',
                isLoading: false,
                error: null,
                chatHistory: [],
            };
        } else {
            // File was removed or new file uploaded. Reset everything.
            return initialState;
        }
    default:
      return state;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const { file, parsedData, rawData, userQuery, isLoading, error, chat, chatHistory } = state;
  
  const mainContentRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (mainContentRef.current) {
        mainContentRef.current.scrollTop = mainContentRef.current.scrollHeight;
    }
  }, [chatHistory, (chatHistory[chatHistory.length - 1] || {}).content]); // Scroll on new message or content update


  const resetState = (keepFile = false) => {
    dispatch({ type: 'RESET_STATE', payload: { keepFile } });
  }

  const handleFileChange = async (selectedFile: File | null) => {
    if (!selectedFile) {
        resetState(false);
        return;
    }

    if (selectedFile.size > MAX_FILE_SIZE) {
        dispatch({ type: 'SET_ERROR', payload: `File is too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.` });
        resetState(false);
        return;
    }
    
    resetState(true);
    dispatch({ type: 'START_LOADING' });
    dispatch({ type: 'SET_FILE', payload: selectedFile });

    try {
        const { data, raw } = await parseFile(selectedFile);
        const newChat = createChat(raw);
        dispatch({ type: 'SET_PARSED_DATA', payload: { data, rawData: raw, chat: newChat }});
    } catch(err: any) {
        dispatch({ type: 'SET_ERROR', payload: err.message });
        resetState(false);
    } finally {
        dispatch({ type: 'FINISH_STREAM' }); // Re-use to set loading to false
    }
  };

  const handleSendQuery = useCallback(async (query: string, task?: Task) => {
    if (!chat || !parsedData) {
      dispatch({ type: 'SET_ERROR', payload: 'Please upload a valid data file first.' });
      return;
    }
    if (!query) {
      dispatch({ type: 'SET_ERROR', payload: 'Please enter a message.' });
      return;
    }

    dispatch({ type: 'START_LOADING' });
    dispatch({ type: 'SET_USER_QUERY', payload: '' });
    
    dispatch({ type: 'ADD_TO_HISTORY', payload: { role: Role.USER, content: query, type: 'text' }});

    const currentTask = task || Task.INSIGHTS;

    try {
        if (currentTask === Task.Dashboard) {
            dispatch({ type: 'ADD_TO_HISTORY', payload: { role: Role.MODEL, type: 'dashboard', content: [], isLoading: true } });
            const analysisResult = await sendMessage(chat, query, currentTask);
            dispatch({ type: 'UPDATE_LAST_IN_HISTORY', payload: { content: analysisResult.content, isLoading: false } });
            dispatch({ type: 'FINISH_STREAM' });
        } else {
            dispatch({ type: 'ADD_TO_HISTORY', payload: { role: Role.MODEL, type: 'text', content: '', isLoading: true } });
            const stream = await sendMessageStream(chat, query, currentTask);
            for await (const chunk of stream) {
                dispatch({ type: 'UPDATE_LAST_IN_HISTORY', payload: { content: chunk, isLoading: true }});
            }
            dispatch({ type: 'FINISH_STREAM' });
        }

    } catch (e: any) {
      console.error(e);
      let friendlyMessage: string;
      const errorMessage = e.message?.toLowerCase() || '';

      if (errorMessage.includes('api key')) {
          friendlyMessage = 'Your API key is not configured correctly. Please ensure it is set up properly in your environment.';
      } else if (errorMessage.includes('429') || errorMessage.includes('resource has been exhausted')) {
          friendlyMessage = 'The service is currently busy due to high demand. Please wait a moment before trying again.';
      } else if (errorMessage.includes('safety')) {
          friendlyMessage = 'The response was blocked due to safety settings. Please modify your request.';
      } else if (errorMessage.includes('invalid dashboard configuration')) {
          friendlyMessage = e.message; // Use the specific error from geminiService
      } else if (errorMessage.includes('500') || errorMessage.includes('internal error')) {
          friendlyMessage = 'An internal error occurred with the AI service. Please try again later.';
      } else {
          friendlyMessage = 'An unexpected error occurred. Please check your network connection or try again.';
      }
      
      dispatch({ type: 'FAIL_LAST_IN_HISTORY', payload: friendlyMessage });
    }
  }, [chat, parsedData]);

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-slate-900 font-sans text-slate-200">
      <header className="md:hidden flex items-center justify-between p-4 border-b border-slate-700">
          <div className="flex items-center">
            <BotIcon className="w-8 h-8 mr-2 text-cyan-400" />
            <h1 className="text-xl font-bold text-white">FluxlyAi</h1>
          </div>
          <button
              onClick={() => resetState(true)}
              className="flex items-center gap-2 text-sm bg-cyan-600 hover:bg-cyan-500 transition-colors text-white font-semibold py-2 px-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900 focus:ring-cyan-500"
            >
              <PlusIcon className="w-4 h-4" />
              New Chat
            </button>
      </header>
      
      <aside className="w-full md:w-1/3 lg:w-1/4 p-4 md:p-6 bg-slate-800/50 flex flex-col border-r border-slate-700/50">
        <div className="hidden md:flex items-center justify-between mb-6">
          <div className="flex items-center">
            <BotIcon className="w-8 h-8 mr-3 text-cyan-400" />
            <h1 className="text-xl font-bold text-white">FluxlyAi</h1>
          </div>
          <button
            onClick={() => resetState(true)}
            className="flex items-center gap-2 text-sm bg-cyan-600 hover:bg-cyan-500 transition-colors text-white font-semibold py-2 px-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 focus:ring-cyan-500"
          >
            <PlusIcon className="w-4 h-4" />
            New Chat
          </button>
        </div>
        
        <div className="flex-grow flex flex-col gap-6">
            <label className="text-sm font-semibold text-slate-300 mb-2 block">Upload Data</label>
            <DataUpload file={file} onFileChange={handleFileChange} disabled={isLoading} />
        </div>

        
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden">
        <div ref={mainContentRef} className="flex-1 p-4 md:p-6 overflow-y-auto space-y-6">
            {!file ? (
                <div className="flex flex-col items-center justify-center h-full text-center text-slate-400">
                    <UploadCloudIcon className="w-24 h-24 mb-4 text-slate-600" />
                    <h2 className="text-2xl font-semibold text-slate-300">Unlock Insights from Your Data</h2>
                    <p className="mt-2 max-w-md">
                    To get started, upload a CSV or Excel file to begin your analysis.
                    </p>
                </div>
            ) : isLoading && !parsedData ? (
                <div className="flex flex-col items-center justify-center h-full text-center text-slate-400">
                    <SpinnerIcon className="w-16 h-16 mb-4 text-cyan-400 animate-spin" />
                    <h2 className="text-xl font-semibold text-slate-300">Processing File...</h2>
                    <p className="mt-2 max-w-md">
                        Getting your data ready for analysis. This should only take a moment.
                    </p>
                </div>
            ) : chatHistory.length > 0 ? (
                chatHistory.map((msg, index) => <ChatMessage key={index} message={msg} />)
            ) : (
                <div className="h-full flex flex-col">
                    <DataPreview data={parsedData!} rawData={rawData!} fileName={file!.name} />
                    <SuggestionChips onSelect={(task, query) => handleSendQuery(query, task)} />
                </div>
            )}
            {error && <div role="alert" className="text-red-400 text-sm p-3 bg-red-900/50 border border-red-700 rounded-lg text-center">{error}</div>}
        </div>

        <div className="p-4 md:p-6 border-t border-slate-700/50 bg-slate-800/20">
            <div className="relative">
                <textarea
                    value={userQuery}
                    onChange={(e) => dispatch({ type: 'SET_USER_QUERY', payload: e.target.value })}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSendQuery(userQuery);
                        }
                    }}
                    placeholder={!file ? "Upload a file to start..." : "Ask a follow-up question..."}
                    disabled={!file || isLoading}
                    className="w-full h-12 p-3 pr-12 bg-slate-700 border border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 transition-all text-slate-200 disabled:opacity-50 resize-none"
                    rows={1}
                />
                <button
                    onClick={() => handleSendQuery(userQuery)}
                    disabled={!file || isLoading || !userQuery}
                    aria-label="Send message"
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-2 bg-cyan-600 text-white rounded-md hover:bg-cyan-500 disabled:bg-slate-600 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-700 focus:ring-cyan-500"
                >
                    <SendIcon className="w-5 h-5" />
                </button>
            </div>
        </div>
      </main>
    </div>
  );
}