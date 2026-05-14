// ── Socket.IO client ──

import { io, Socket } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL ?? "";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL || window.location.origin, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
    });
  }
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
