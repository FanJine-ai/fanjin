import { Server } from "socket.io";
import scriptAgent from "./routes/scriptAgent";

export default (io: Server) => {
  const routes: Record<string, (nsp: ReturnType<Server["of"]>) => void> = {
    scriptAgent,
  };

  for (const [name, handler] of Object.entries(routes)) {
    const nsp = io.of(`/api/socket/${name}`);
    handler(nsp);
    console.log(`[Socket] 注册命名空间: /api/socket/${name}`);
  }
};
