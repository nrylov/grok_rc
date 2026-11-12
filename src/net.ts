import os from "node:os";

const SKIP_INTERFACE = /^(lo|bridge|awdl|llw|utun|vmnet|ap|gif|stf|anpi)/;

export function lanAddress(): string {
  const nets = os.networkInterfaces();
  const ranked: { name: string; address: string; rank: number }[] = [];
  for (const [name, list] of Object.entries(nets)) {
    if (SKIP_INTERFACE.test(name)) continue;
    for (const entry of list || []) {
      if (entry.internal) continue;
      const family = entry.family as string | number;
      if (family !== "IPv4" && family !== 4) continue;
      const rank = name === "en0" ? 0 : name === "en1" ? 1 : isPrivate(entry.address) ? 2 : 3;
      ranked.push({ name, address: entry.address, rank });
    }
  }
  ranked.sort((a, b) => a.rank - b.rank);
  const preferred = ranked.find((entry) => entry.rank < 3) || ranked[0];
  return preferred?.address || "127.0.0.1";
}

function isPrivate(ip: string): boolean {
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  const parts = ip.split(".").map((part) => Number(part));
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

export function computerName(): string {
  return os.hostname().replace(/\.local$/i, "");
}
