import { useState, type FormEvent } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import type { AuthStatusResponse } from '../types';

interface AuthScreenProps {
  authStatus: AuthStatusResponse;
  onAuthenticated: (token: string, username: string) => void;
}

export function AuthScreen({ authStatus, onAuthenticated }: AuthScreenProps) {
  const [username, setUsername] = useState(authStatus.username || 'admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSetup = authStatus.needsSetup;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (isSetup && password !== confirmPassword) {
      setError('Пароли не совпадают');
      return;
    }

    setLoading(true);
    try {
      const result = isSetup
        ? await api.claimAdmin(username, password)
        : await api.login(username, password);
      onAuthenticated(result.token, result.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка авторизации');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-[#111827] border border-[#1E293B] rounded-xl p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-[#1E293B] flex items-center justify-center text-[#60A5FA]">
            {isSetup ? <ShieldCheck className="w-5 h-5" /> : <Lock className="w-5 h-5" />}
          </div>
          <div>
            <h1 className="text-xl font-semibold text-[#F8FAFC] tracking-tight">
              Кузница Кода
            </h1>
            <p className="text-xs text-[#94A3B8]">
              {isSetup
                ? 'Первичная настройка пароля администратора'
                : 'Вход в панель управления конвейером'}
            </p>
          </div>
        </div>

        {isSetup && (
          <div className="mb-5 p-3 rounded-lg bg-[#0F172A] border border-[#1E293B] text-xs text-[#CBD5E1] leading-relaxed">
            Пароль администратора не задан в <code className="text-[#60A5FA]">.env</code>. Задайте
            надёжный пароль для локального доступа.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="auth-username" className="block text-xs font-medium text-[#CBD5E1] mb-1.5">
              Имя пользователя
            </label>
            <input
              id="auth-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              className="w-full px-3.5 py-2.5 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-xs font-medium text-[#CBD5E1] mb-1.5">
              Пароль
            </label>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={isSetup ? 6 : 4}
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              placeholder={isSetup ? 'Не менее 6 символов' : 'Введите пароль'}
              className="w-full px-3.5 py-2.5 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          {isSetup && (
            <div>
              <label
                htmlFor="auth-password-confirm"
                className="block text-xs font-medium text-[#CBD5E1] mb-1.5"
              >
                Подтверждение пароля
              </label>
              <input
                id="auth-password-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
                placeholder="Повторите пароль"
                className="w-full px-3.5 py-2.5 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
              />
            </div>
          )}

          {error && (
            <div role="alert" className="p-3 rounded-lg bg-[#450A0A]/60 border border-[#991B1B] text-xs text-[#FCA5A5]">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-sm font-medium text-white transition-colors cursor-pointer whitespace-nowrap"
          >
            {loading ? 'Проверка...' : isSetup ? 'Сохранить пароль и войти' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  );
}
