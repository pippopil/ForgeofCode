import type {
  AuthStatusResponse,
  ProjectDTO,
  ProjectDetailResponse,
  SettingsResponse,
  StackErrorLogDTO,
  StackType,
  SystemMetricsSnapshot,
} from './types';

let memoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  memoryToken = token;
}

export function getAuthToken(): string | null {
  return memoryToken;
}

async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (memoryToken) {
    headers.set('Authorization', `Bearer ${memoryToken}`);
  }

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    const errMsg =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }

  return data as T;
}

export const api = {
  authStatus: () => apiFetch<AuthStatusResponse>('/api/auth/status'),
  claimAdmin: (username: string, password: string) =>
    apiFetch<{ token: string; username: string }>('/api/auth/claim', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    apiFetch<{ token: string; username: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  createWsTicket: () => apiFetch<{ ticket: string }>('/api/auth/ws-ticket', { method: 'POST' }),

  getSystemMetrics: () => apiFetch<SystemMetricsSnapshot>('/api/system/metrics'),
  getStackErrors: (stack?: StackType | '') => {
    const qs = stack ? `?stack=${encodeURIComponent(stack)}` : '';
    return apiFetch<{ logs: StackErrorLogDTO[] }>(`/api/logs/errors${qs}`);
  },

  getProjects: () => apiFetch<{ projects: ProjectDTO[] }>('/api/projects'),
  createProject: (payload: {
    name: string;
    spec: string;
    stack: StackType;
    budget_rub: number;
    skip_review?: boolean;
  }) =>
    apiFetch<{ project: ProjectDTO }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getProjectDetail: (id: string) => apiFetch<ProjectDetailResponse>(`/api/projects/${encodeURIComponent(id)}`),
  getProjectFile: (id: string, filePath: string) =>
    apiFetch<{ path: string; content: string }>(
      `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(filePath)}`
    ),
  cancelProject: (id: string) =>
    apiFetch<{ cancelled: boolean }>(`/api/projects/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    }),
  resumeProject: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    }),
  refineProject: (id: string, instruction: string) =>
    apiFetch<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/refine`, {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    }),
  deleteProject: (id: string) =>
    apiFetch<{ deleted: boolean }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  downloadZip: async (id: string) => {
    const headers = new Headers();
    if (memoryToken) headers.set('Authorization', `Bearer ${memoryToken}`);
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/zip`, { headers });
    if (!res.ok) {
      throw new Error('Не удалось скачать ZIP-архив');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${id}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  getSettings: () => apiFetch<SettingsResponse>('/api/settings'),
  updateSettings: (payload: Record<string, unknown>) =>
    apiFetch<{ ok: boolean }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getLlmModels: () => apiFetch<{ models: string[] }>('/api/llm/models'),
  pingLlm: (model?: string) =>
    apiFetch<{
      ok: boolean;
      latencyMs: number;
      modelChecked: string | null;
      modelsCount: number;
      replyPreview?: string;
    }>('/api/llm/ping', {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),
};
