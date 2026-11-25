import type { IncomingMessage, Server } from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { WsClientMessageSchema } from '../shared/contracts';
import { consumeWsTicket } from './auth';
import { systemMonitor } from './systemMonitor';

interface ClientMeta {
  ws: WebSocket;
  subscribedProjects: Set<string>;
}

class WsHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<ClientMeta>();

  public attach(httpServer: Server): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });

    httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
      try {
        const parsedUrl = new URL(request.url || '/', 'http://localhost');
        if (parsedUrl.pathname !== '/ws') {
          // Оставляем другие пути (если есть) нетронутыми или закрываем
          return;
        }
        const ticket = parsedUrl.searchParams.get('ticket') || '';
        const username = consumeWsTicket(ticket);
        if (!username) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        this.wss?.handleUpgrade(request, socket, head, (ws) => {
          this.handleConnection(ws);
        });
      } catch {
        socket.destroy();
      }
    });

    systemMonitor.configure({
      getWsClientCount: () => this.clients.size,
      onMetrics: (snapshot) => {
        this.broadcastAll({ type: 'system:metrics', data: snapshot });
      },
    });
    systemMonitor.start(2000);
  }

  private handleConnection(ws: WebSocket): void {
    const meta: ClientMeta = { ws, subscribedProjects: new Set() };
    this.clients.add(meta);

    // Сразу отправляем актуальный снимок системных ресурсов
    this.sendSafe(ws, {
      type: 'system:metrics',
      data: systemMonitor.getSnapshot(),
    });

    ws.on('message', (raw) => {
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        const json = JSON.parse(text);
        const parsed = WsClientMessageSchema.safeParse(json);
        if (!parsed.success) {
          this.sendSafe(ws, {
            type: 'error',
            message: 'Некорректное WebSocket-сообщение',
          });
          return;
        }

        const msg = parsed.data;
        if (msg.type === 'subscribe') {
          meta.subscribedProjects.add(msg.projectId);
        } else if (msg.type === 'unsubscribe') {
          meta.subscribedProjects.delete(msg.projectId);
        } else if (msg.type === 'ping') {
          this.sendSafe(ws, { type: 'pong', ts: Date.now() });
        }
      } catch {
        this.sendSafe(ws, { type: 'error', message: 'Ошибка разбора JSON в WebSocket' });
      }
    });

    ws.on('close', () => {
      this.clients.delete(meta);
    });

    ws.on('error', () => {
      this.clients.delete(meta);
    });
  }

  private sendSafe(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // Игнорируем сбой отправки закрывающемуся клиенту
      }
    }
  }

  public broadcastAll(payload: unknown): void {
    const serialized = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(serialized);
        } catch {
          // Игнорируем
        }
      }
    }
  }

  public broadcastProject(projectId: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    for (const client of this.clients) {
      if (
        client.ws.readyState === WebSocket.OPEN &&
        (client.subscribedProjects.has(projectId) || client.subscribedProjects.size === 0)
      ) {
        try {
          client.ws.send(serialized);
        } catch {
          // Игнорируем
        }
      }
    }
  }

  public getClientCount(): number {
    return this.clients.size;
  }
}

export const wsHub = new WsHub();
