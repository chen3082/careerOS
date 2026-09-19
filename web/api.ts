export const base = import.meta.env.BASE_URL.replace(/\/$/, "");
export class ApiError extends Error {
  constructor(
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}
const labels: Record<string, string> = {
  LOGIN_REQUIRED: "請先登入",
  INVALID_CREDENTIALS: "Email 或密碼不正確",
  INVITE_REQUIRED: "請輸入有效的工作台邀請碼",
  INVALID_INPUT: "請檢查欄位格式",
  REVISION_CONFLICT: "資料已更新，請重新載入後再儲存",
  VERSION_CONFLICT: "這筆資料剛更新，請重試",
  DAILY_BUDGET_REACHED: "已達每日用量上限",
  ALREADY_SUBMITTED: "這個職缺已投遞，已阻止重複操作",
  RESUME_NEEDS_REVIEW: "請先確認履歷內容與事實來源",
  API_KEY_REQUIRED: "請先在偏好與連接設定 API key",
  TOO_MANY_ATTEMPTS: "嘗試次數過多，請稍後再試",
  GOOGLE_OAUTH_NOT_CONFIGURED: "Google 連接尚未由管理員設定",
  NOT_FOUND: "找不到資料或沒有存取權限",
  FILE_TYPE_OR_SIZE_NOT_ALLOWED: "支援文字、PDF、DOCX 與音檔，單檔最多 20 MB",
  SOURCE_WITHDRAWN_OR_EXPIRED: "履歷引用了已撤回或失效的經驗，請建立新版本",
  CAREER_REVISION_REQUIRED: "請先確認至少一項經驗",
  CONSENT_EXPIRED: "授權請求已過期，請回 Claude 重新連接",
  NETWORK_ERROR: "連線中斷，請確認網路後再試；送出前請先核對是否已保存",
  CAREER_JOB_SAMPLE_REQUIRED: "請先保存幾份目標職缺，讓分析有資料依據",
  AI_MODE_DISABLED: "目前為手動模式，請先在設定切換 MCP 或 BYOK",
  APPLICATION_CLOSED: "這筆申請已有最終結果，無法用此事件覆蓋",
  STORAGE_QUOTA_REACHED: "已達私人附件空間上限（512 MB 或 2,000 個檔案）",
  AUDIO_INVALID_OR_OVER_3_MINUTES: "音檔無法解析或超過三分鐘，請裁剪或改用 WAV",
  EXPORT_BUSY_TRY_AGAIN: "正在產生另一份文件，請稍後重試",
  TRANSFER_GROUP_OWNER_FIRST: "請先移轉或刪除你擁有的小組",
};
export const message = (e: unknown) =>
  e instanceof ApiError
    ? (labels[e.code] ?? e.code)
    : e instanceof Error
      ? e.message
      : "操作未完成，請稍後再試";
export async function api<T = any>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch(base + "/api" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
      ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    body:
      data === undefined
        ? undefined
        : data instanceof FormData
          ? data
          : JSON.stringify(data),
  }).catch(() => {
    throw new ApiError("NETWORK_ERROR");
  });
  const body = await response.json().catch(() => ({ error: "REQUEST_FAILED" }));
  if (!response.ok)
    throw new ApiError(body.error ?? "REQUEST_FAILED", body.details);
  return body;
}
