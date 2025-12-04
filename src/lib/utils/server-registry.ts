import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";

export interface ServerInfo {
  pid: number;
  port: number;
  projectRoot: string;
  startTime: number;
}

const REGISTRY_PATH = path.join(PATHS.globalRoot, "servers.json");

function loadRegistry(): ServerInfo[] {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return [];
    const data = fs.readFileSync(REGISTRY_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveRegistry(servers: ServerInfo[]) {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(servers, null, 2));
  } catch (err) {
    console.error("Failed to save server registry:", err);
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerServer(info: ServerInfo) {
  const servers = loadRegistry().filter((s) => isProcessRunning(s.pid));
  // Remove any existing entry for this projectRoot to avoid duplicates
  const filtered = servers.filter((s) => s.projectRoot !== info.projectRoot);
  filtered.push(info);
  saveRegistry(filtered);
}

export function unregisterServer(pid: number) {
  const servers = loadRegistry();
  const filtered = servers.filter((s) => s.pid !== pid);
  saveRegistry(filtered);
}

export function listServers(): ServerInfo[] {
  const servers = loadRegistry();
  // Clean up stale entries on read
  const active = servers.filter((s) => isProcessRunning(s.pid));
  if (active.length !== servers.length) {
    saveRegistry(active);
  }
  return active;
}

export function getServerForProject(
  projectRoot: string,
): ServerInfo | undefined {
  return listServers().find((s) => s.projectRoot === projectRoot);
}
