import { PDFDocument } from "pdf-lib";
import { assert, boundedText } from "./security.ts";
import type { Fetcher } from "./feishu.ts";
import { ReadFailure } from "./readonly.ts";
// Small resume attachments only. Larger files require chunked object storage.
export const ATTACHMENT_LIMIT = 512 * 1024;
export async function downloadEventAttachment(fetcher: Fetcher, token: string, a: Record<string, any>) {
  const get = async (path: string) => {
    try { return await fetcher("https://open.feishu.cn/open-apis" + path, {headers:{Authorization:"Bearer " + token},redirect:"manual",signal:AbortSignal.timeout(20000)}); }
    catch { throw new ReadFailure("provider_network_error",503); }
  };
  const fail = async (r: Response) => {
    let v: any; try { v = JSON.parse(await boundedText(r,32768)); } catch {}
    const denied = r.status === 403 || [99991672,99991679,1061004,1061003].includes(v?.code);
    throw new ReadFailure(denied ? "resource_access_denied" : "attachment_download_failed", denied ? 403 : 502, v?.code);
  };
  const er = await get(`/calendar/v4/calendars/${encodeURIComponent(a.calendar_id)}/events/${encodeURIComponent(a.event_id)}`);
  if (!er.ok) await fail(er);
  const raw = JSON.parse(await boundedText(er,1048576));
  if(raw.code !== 0) throw new ReadFailure("resource_access_denied",403,raw.code);
  const e = raw.data?.event;
  assert(e?.event_id === a.event_id && e.status !== "cancelled", "event_unavailable",422);
  const list = e.attachments;
  assert(Array.isArray(list), "attachment_not_found",404);
  const matching = list.filter((v:any)=>v.file_token === a.token);
  assert(matching.length === 1, "attachment_not_found",404);
  const attachment = matching[0];
  const expected = Number(attachment.file_size);
  assert(Number.isSafeInteger(expected) && expected > 0 && expected <= ATTACHMENT_LIMIT, "attachment_size_limit_512k",422);
  assert(typeof attachment.name === "string" && attachment.name.length <= 512 && /\.pdf$/i.test(attachment.name), "pdf_attachment_required",422);
  const r = await get(`/drive/v1/medias/${encodeURIComponent(a.token)}/download`);
  if (!r.ok || /json|html/i.test(r.headers.get("content-type") ?? "")) await fail(r);
  const length = r.headers.get("content-length");
  assert(length === null || Number(length) === expected, "attachment_size_mismatch",502);
  const reader=r.body?.getReader(); assert(reader,"attachment_download_empty",502);
  const chunks: Uint8Array[]=[]; let size=0;
  try { for(;;){ const {done,value}=await reader.read(); if(done)break; size+=value.length; assert(size<=ATTACHMENT_LIMIT && size<=expected,"attachment_size_mismatch",502); chunks.push(value); } }
  finally { await reader.cancel().catch(()=>{}); }
  assert(size === expected,"attachment_size_mismatch",502);
  const bytes=new Uint8Array(size); let offset=0; for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  assert(new TextDecoder().decode(bytes.subarray(0,5)) === "%PDF-" && new TextDecoder().decode(bytes.subarray(-1024)).includes("%%EOF"),"attachment_invalid_pdf",502);
  let pdf; try {pdf=await PDFDocument.load(bytes,{throwOnInvalidObject:true,updateMetadata:false});} catch {throw new ReadFailure("attachment_pdf_unreadable",422);}
  const pages=pdf.getPageCount(); assert(pages>0 && pages<=100,"attachment_pdf_page_limit",422);
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),v=>v.toString(16).padStart(2,"0")).join("");
  let binary=""; for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {name:attachment.name,bytes:size,pages,sha256,mime_type:"application/pdf",validation:"pdf_parsed",base64:btoa(binary)};
}
