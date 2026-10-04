// src/desec/client.ts — deSEC.io API 封装（完整 DNS 记录管理）
const API_BASE = "https://desec.io/api/v1";

export interface DesecConfig {
  token: string;
  vpsIp: string;
}

interface Rrset {
  type: string;
  subname: string;
  ttl: number;
  records: string[];
}

export interface RrsetInfo {
  type: string;
  subname: string;
  ttl: number;
  records: string[];
}

function headers(cfg: DesecConfig): Record<string, string> {
  return {
    Authorization: `Token ${cfg.token}`,
    "Content-Type": "application/json",
  };
}

async function patchRrsets(cfg: DesecConfig, domain: string, rrsets: Rrset[]): Promise<void> {
  const res = await fetch(`${API_BASE}/domains/${domain}/rrsets/`, {
    method: "PATCH",
    headers: headers(cfg),
    body: JSON.stringify(rrsets),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`deSEC PATCH ${domain} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
}

/**
 * 为域名配置完整收信 DNS：mail.{domain} A 记录、@ MX 记录、@ SPF TXT。
 * 调用前需保证该域名已托管在 deSEC（NS 已指向 deSEC）。
 */
export async function setupDomainMx(cfg: DesecConfig, domain: string): Promise<void> {
  if (!cfg.token) throw new Error("deSEC token not configured (DESEC_TOKEN)");
  if (!cfg.vpsIp) throw new Error("vps ip not configured (VPS_IP)");
  await patchRrsets(cfg, domain, [
    { type: "A", subname: "mail", ttl: 3600, records: [cfg.vpsIp] },
    { type: "MX", subname: "", ttl: 3600, records: [`10 mail.${domain}.`] },
    { type: "TXT", subname: "", ttl: 3600, records: [`"v=spf1 ip4:${cfg.vpsIp} ~all"`] },
  ]);
}

/** 查询域名在 deSEC 上的全部 DNS 记录（A/MX/TXT 等） */
export async function listDomainRrsets(cfg: DesecConfig, domain: string): Promise<RrsetInfo[]> {
  if (!cfg.token) throw new Error("deSEC token not configured (DESEC_TOKEN)");
  const res = await fetch(`${API_BASE}/domains/${domain}/rrsets/`, { headers: headers(cfg) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`deSEC GET ${domain} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as RrsetInfo[];
  return data;
}

/** 校验某域名当前 MX 是否已指向本服务（查 deSEC NS，绕过全球传播） */
export async function verifyDomainMx(cfg: DesecConfig, domain: string): Promise<{ ok: boolean; records: string[] }> {
  if (!cfg.token) return { ok: false, records: [] };
  const res = await fetch(`${API_BASE}/domains/${domain}/rrsets/MX/`, { headers: headers(cfg) });
  if (!res.ok) return { ok: false, records: [] };
  const data = (await res.json()) as { records?: string[] };
  return { ok: Array.isArray(data.records) && data.records.length > 0, records: data.records ?? [] };
}
