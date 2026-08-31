export interface QpcrMeltingPoint {
  x: number;
  y: number;
}

export interface QpcrMeltingWell {
  points: QpcrMeltingPoint[];
  well: string;
}

export interface QpcrMeltingChannel {
  channel: string;
  wells: QpcrMeltingWell[];
}

export interface QpcrMeltingPlate {
  channels: QpcrMeltingChannel[];
}

export interface QpcrMeltingPlateData {
  derivativesCsvFileId: number | null;
  plate: QpcrMeltingPlate;
}

interface RawPlate {
  channels?: unknown;
}

interface RawChannel {
  channel?: unknown;
  wells?: unknown;
}

interface RawWell {
  points?: unknown;
  well?: unknown;
}

export function parseQpcrMeltingPlateJson(raw: unknown): QpcrMeltingPlate {
  if (!raw || typeof raw !== "object") {
    throw new Error("qPCR melting plate JSON is not an object");
  }
  const payload = raw as RawPlate;
  if (!Array.isArray(payload.channels)) {
    throw new Error("qPCR melting plate JSON is missing channels");
  }
  return { channels: payload.channels.map(parseChannel) };
}

function parseChannel(raw: unknown): QpcrMeltingChannel {
  const ch = (raw ?? {}) as RawChannel;
  if (typeof ch.channel !== "string" || ch.channel.length === 0) {
    throw new Error("qPCR melting channel is missing a name");
  }
  const wells = Array.isArray(ch.wells) ? ch.wells.map(parseWell) : [];
  return { channel: ch.channel, wells };
}

function parseWell(raw: unknown): QpcrMeltingWell {
  const w = (raw ?? {}) as RawWell;
  if (typeof w.well !== "string" || w.well.length === 0) {
    throw new Error("qPCR melting well is missing a label");
  }
  const points = Array.isArray(w.points)
    ? w.points
        .map((p) => {
          if (!p || typeof p !== "object") {
            return null;
          }
          const rec = p as { x?: unknown; y?: unknown };
          const x = Number(rec.x);
          const y = Number(rec.y);
          return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
        })
        .filter((p): p is QpcrMeltingPoint => p !== null)
    : [];
  return { well: w.well, points };
}
