import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setAuthToken } from './api';
import { AuthScreen } from './components/AuthScreen';
import { NewProjectView } from './components/NewProjectView';
import { ProjectDetailView } from './components/ProjectDetailView';
import { ProjectsView } from './components/ProjectsView';
import { SettingsView } from './components/SettingsView';
import { Sidebar, type ScreenName } from './components/Sidebar';
import { SystemBanner } from './components/SystemBanner';
import type {
  AgentEventDTO,
  AuthStatusResponse,
  CommandRunDTO,
  ProjectDTO,
  ProjectDetailResponse,
  StackErrorLogDTO,
  StackType,
  SystemMetricsSnapshot,
} from './types';

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [username, setUsername] = useState<string | null>(null);

  const [screen, setScreen] = useState<ScreenName>('projects');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<SystemMetricsSnapshot | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [stackErrors, setStackErrors] = useState<StackErrorLogDTO[]>([]);
  const [selectedErrorStack, setSelectedErrorStack] = useState<StackType | ''>('');

  const [projectDetail, setProjectDetail] = useState<ProjectDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [defaultBudgetRub, setDefaultBudgetRub] = useState(50);
  const [defaultSkipReview, setDefaultSkipReview] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const selectedProjectRef = useRef<string | null>(null);
  selectedProjectRef.current = selectedProjectId;
  const errorStackRef = useRef<StackType | ''>('');
  errorStackRef.current = selectedErrorStack;

  // Проверка статуса авторизации при старте
  useEffect(() => {
    api
      .authStatus()
      .then((res) => setAuthStatus(res))
      .catch(() => {
        setAuthStatus({ needsSetup: false, username: 'admin', source: 'unclaimed' });
      })
      .finally(() => setAuthChecked(true));
  }, []);

  const loadProjectsAndTelemetry = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const [projRes, metricsRes, errRes, settingsRes] = await Promise.all([
        api.getProjects(),
        api.getSystemMetrics(),
        api.getStackErrors(errorStackRef.current),
        api.getSettings(),
      ]);
      setProjects(projRes.projects);
      setMetrics(metricsRes);
      setStackErrors(errRes.logs);
      setDefaultBudgetRub(settingsRes.default_project_budget_rub);
      setDefaultSkipReview(settingsRes.skip_review);
    } catch {
      // Обработка при потере соединения
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const loadProjectDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const detail = await api.getProjectDetail(id);
      setProjectDetail(detail);
    } catch {
      setProjectDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleFilterStackErrors = useCallback(async (stack: StackType | '') => {
    setSelectedErrorStack(stack);
    try {
      const res = await api.getStackErrors(stack);
      setStackErrors(res.logs);
    } catch {
      // Игнорируем временную ошибку фильтра
    }
  }, []);

  // Подписка на выбранный проект по активному WebSocket
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !selectedProjectId) return;
    ws.send(JSON.stringify({ type: 'subscribe', projectId: selectedProjectId }));
    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribe', projectId: selectedProjectId }));
      }
    };
  }, [selectedProjectId, wsConnected]);

  // Подключение WebSocket с авто-реконнектом и догрузкой истории из БД
  useEffect(() => {
    if (!username) return;

    let closedByUser = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    async function connect() {
      if (closedByUser) return;
      try {
        const { ticket } = await api.createWsTicket();
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${window.location.host}/ws?ticket=${encodeURIComponent(ticket)}`;
        ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          attempt = 0;
          setWsConnected(true);
          // При каждом подключении/реконнекте догружаем актуальную историю из БД
          loadProjectsAndTelemetry();
          if (selectedProjectRef.current) {
            ws?.send(
              JSON.stringify({ type: 'subscribe', projectId: selectedProjectRef.current })
            );
            loadProjectDetail(selectedProjectRef.current);
          }
        };

        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data) as { type: string; data?: unknown };
            if (msg.type === 'system:metrics' && msg.data) {
              setMetrics(msg.data as SystemMetricsSnapshot);
            } else if (msg.type === 'projects:list_updated') {
              api
                .getProjects()
                .then((r) => setProjects(r.projects))
                .catch(() => {});
              api
                .getStackErrors(errorStackRef.current)
                .then((r) => setStackErrors(r.logs))
                .catch(() => {});
            } else if (msg.type === 'project:updated' && msg.data) {
              const updated = msg.data as ProjectDTO;
              setProjects((prev) =>
                prev.map((p) => (p.id === updated.id ? updated : p))
              );
              if (updated.id === selectedProjectRef.current) {
                setProjectDetail((prev) =>
                  prev ? { ...prev, project: updated } : prev
                );
                // Обновляем список файлов/diff при завершении шага CODE/FIX/DONE
                if (
                  updated.stage === 'INSTALL' ||
                  updated.stage === 'DONE' ||
                  updated.status === 'done'
                ) {
                  loadProjectDetail(updated.id);
                }
              }
            } else if (msg.type === 'project:event' && msg.data) {
              const event = msg.data as AgentEventDTO;
              if (event.project_id === selectedProjectRef.current) {
                setProjectDetail((prev) => {
                  if (!prev) return prev;
                  if (prev.events.some((e) => e.id === event.id)) return prev;
                  const nextSpent =
                    Math.round((prev.project.spent_rub + (event.cost_rub || 0)) * 10000) /
                    10000;
                  return {
                    ...prev,
                    project: { ...prev.project, spent_rub: nextSpent },
                    events: [...prev.events, event],
                  };
                });
              }
            } else if (msg.type === 'project:command' && msg.data) {
              const cmd = msg.data as CommandRunDTO;
              if (cmd.project_id === selectedProjectRef.current) {
                setProjectDetail((prev) => {
                  if (!prev) return prev;
                  if (prev.commandRuns.some((c) => c.id === cmd.id)) return prev;
                  return { ...prev, commandRuns: [...prev.commandRuns, cmd] };
                });
              }
            }
          } catch {
            // Игнорируем некорректный фрейм
          }
        };

        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
          setWsConnected(false);
          if (!closedByUser) {
            attempt += 1;
            const delay = Math.min(10000, 1000 * Math.pow(1.5, Math.min(attempt, 6)));
            reconnectTimer = setTimeout(connect, delay);
          }
        };

        ws.onerror = () => {
          ws?.close();
        };
      } catch {
        setWsConnected(false);
        if (!closedByUser) {
          attempt += 1;
          reconnectTimer = setTimeout(connect, 3000);
        }
      }
    }

    loadProjectsAndTelemetry();
    connect();

    return () => {
      closedByUser = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      wsRef.current = null;
    };
  }, [username, loadProjectsAndTelemetry, loadProjectDetail]);

  function handleAuthenticated(token: string, user: string) {
    setAuthToken(token);
    setUsername(user);
  }

  function handleLogout() {
    setAuthToken(null);
    setUsername(null);
    setProjects([]);
    setProjectDetail(null);
    setSelectedProjectId(null);
    setScreen('projects');
    api.authStatus().then(setAuthStatus).catch(() => {});
  }

  function openProject(id: string) {
    setSelectedProjectId(id);
    setScreen('detail');
    loadProjectDetail(id);
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center text-sm text-[#94A3B8]">
        Инициализация сервера...
      </div>
    );
  }

  if (!username && authStatus) {
    return <AuthScreen authStatus={authStatus} onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="min-h-screen bg-[#0B0F17] text-[#F1F5F9] flex flex-col">
      <SystemBanner metrics={metrics} wsConnected={wsConnected} />

      <div className="flex flex-1 min-h-0">
        <Sidebar
          activeScreen={screen}
          selectedProjectId={selectedProjectId}
          username={username ?? 'admin'}
          onNavigate={(target) => {
            setScreen(target);
            if (target === 'projects') loadProjectsAndTelemetry();
            if (target === 'detail' && selectedProjectId) loadProjectDetail(selectedProjectId);
          }}
          onLogout={handleLogout}
        />

        <main className="flex-1 min-w-0 overflow-y-auto">
          {screen === 'projects' && (
            <ProjectsView
              projects={projects}
              stackErrors={stackErrors}
              metrics={metrics}
              loading={projectsLoading}
              onOpenProject={openProject}
              onNewProject={() => setScreen('new')}
              onResumeProject={async (id) => {
                await api.resumeProject(id);
                await loadProjectsAndTelemetry();
              }}
              onDeleteProject={async (id) => {
                await api.deleteProject(id);
                if (selectedProjectId === id) {
                  setSelectedProjectId(null);
                  setProjectDetail(null);
                }
                await loadProjectsAndTelemetry();
              }}
              onFilterStackErrors={handleFilterStackErrors}
              selectedErrorStack={selectedErrorStack}
            />
          )}

          {screen === 'new' && (
            <NewProjectView
              metrics={metrics}
              defaultBudgetRub={defaultBudgetRub}
              defaultSkipReview={defaultSkipReview}
              onCreated={(id) => {
                loadProjectsAndTelemetry();
                openProject(id);
              }}
              onCancel={() => setScreen('projects')}
            />
          )}

          {screen === 'detail' && selectedProjectId && (
            <ProjectDetailView
              projectId={selectedProjectId}
              detail={projectDetail}
              loading={detailLoading}
              onRefresh={() => loadProjectDetail(selectedProjectId)}
            />
          )}

          {screen === 'settings' && (
            <SettingsView onSaved={() => loadProjectsAndTelemetry()} />
          )}
        </main>
      </div>
    </div>
  );
}
