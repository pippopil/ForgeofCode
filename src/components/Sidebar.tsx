import { FolderKanban, LogOut, PlusSquare, Settings, TerminalSquare } from 'lucide-react';

export type ScreenName = 'projects' | 'new' | 'detail' | 'settings';

interface SidebarProps {
  activeScreen: ScreenName;
  selectedProjectId: string | null;
  username: string;
  onNavigate: (screen: ScreenName) => void;
  onLogout: () => void;
}

export function Sidebar({
  activeScreen,
  selectedProjectId,
  username,
  onNavigate,
  onLogout,
}: SidebarProps) {
  const navItems: Array<{
    id: ScreenName;
    label: string;
    icon: typeof FolderKanban;
    disabled?: boolean;
  }> = [
    { id: 'projects', label: 'Проекты', icon: FolderKanban },
    { id: 'new', label: 'Новый проект', icon: PlusSquare },
    {
      id: 'detail',
      label: 'Рабочая зона',
      icon: TerminalSquare,
      disabled: !selectedProjectId,
    },
    { id: 'settings', label: 'Настройки', icon: Settings },
  ];

  return (
    <aside className="w-60 shrink-0 bg-[#111827] border-r border-[#1E293B] flex flex-col justify-between">
      <div>
        <div className="px-5 py-5 border-b border-[#1E293B]">
          <div className="font-display text-base font-semibold text-[#F8FAFC] tracking-tight whitespace-nowrap">
            Кузница Кода
          </div>
        </div>

        <nav aria-label="Основная навигация" className="p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeScreen === item.id;
            return (
              <button
                key={item.id}
                type="button"
                disabled={item.disabled}
                onClick={() => onNavigate(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isActive
                    ? 'bg-[#2563EB]/15 text-[#60A5FA] border border-[#2563EB]/40'
                    : item.disabled
                      ? 'text-[#475569] cursor-not-allowed'
                      : 'text-[#CBD5E1] hover:bg-[#1E293B]/70 hover:text-[#F8FAFC]'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="p-4 border-t border-[#1E293B] flex items-center justify-between gap-2">
        <span className="text-xs text-[#94A3B8] truncate">{username}</span>
        <button
          type="button"
          onClick={onLogout}
          aria-label="Выйти из аккаунта"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-[#CBD5E1] hover:text-[#F8FAFC] hover:bg-[#1E293B] transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Выход</span>
        </button>
      </div>
    </aside>
  );
}
