import { Chat } from '@google/genai';

export enum Task {
  Dashboard = 'Analysis Dashboard',
  EDA = 'Data Analysis',
  INSIGHTS = 'Generate Insights',
}

export enum Role {
    USER = 'user',
    MODEL = 'model',
}

export interface ChartConfig {
  chartType: 'bar' | 'line' | 'pie' | 'scatter';
  title?: string;
  data: any[];
  xAxisKey?: string;
  yAxisKey?: string; // for scatter
  dataKeys: string[];
  colors: string[];
  pieDataKey?: string;
  pieNameKey?: string;
}

export type ParsedData = Record<string, string | number>[];
export type ParsedFileResult = { data: ParsedData; raw: string };

export interface AnalysisResult {
  type: 'text' | 'chart' | 'dashboard' | 'error';
  content: string | ChartConfig | ChartConfig[];
}

export interface ChatMessage extends AnalysisResult {
    role: Role;
    isLoading?: boolean;
}

// State Management with useReducer
export interface AppState {
    file: File | null;
    parsedData: ParsedData | null;
    rawData: string | null;
    userQuery: string;
    isLoading: boolean;
    error: string | null;
    chat: Chat | null;
    chatHistory: ChatMessage[];
}

export type Action =
  | { type: 'START_LOADING' }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_USER_QUERY'; payload: string }
  | { type: 'SET_FILE'; payload: File | null }
  | { type: 'SET_PARSED_DATA'; payload: { data: ParsedData; rawData: string; chat: Chat } }
  | { type: 'ADD_TO_HISTORY'; payload: ChatMessage }
  | { type: 'UPDATE_LAST_IN_HISTORY'; payload: { content: any; isLoading: boolean } }
  | { type: 'FINISH_STREAM' }
  | { type: 'RESET_STATE'; payload: { keepFile: boolean } }
  | { type: 'FAIL_LAST_IN_HISTORY'; payload: string };