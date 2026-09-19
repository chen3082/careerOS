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
  LIVE_SUBMISSION_NOT_CONNECTED: "真實平台的投遞尚未連接，沒有送出任何履歷",
  SUBMISSION_OUTCOME_UNKNOWN: "對方可能已收到，已阻止重送；請先查證結果",
  SUBMISSION_NOT_SENT: "送出前檢查未通過，沒有執行送出",
  SUBMISSION_REVIEW_REQUIRED: "請重新核對這次的職缺、文件與表單內容",
  RESUME_PDF_REQUIRED: "請先產生這份履歷的 PDF",
  RESUME_REQUIRED: "請先選擇本次使用的履歷",
  RESUME_NEEDS_REVIEW: "請先確認履歷內容與事實來源",
  API_KEY_REQUIRED: "請先在偏好與連接設定 API key",
  TOO_MANY_ATTEMPTS: "嘗試次數過多，請稍後再試",
  GOOGLE_OAUTH_NOT_CONFIGURED: "Google 連接尚未由管理員設定",
  GOOGLE_LOGIN_NOT_CONFIGURED: "Google 登入尚未由管理員啟用",
  GOOGLE_IDENTITY_INVALID: "Google 身份驗證未完成，請重新載入登入按鈕再試",
  GOOGLE_CHALLENGE_EXPIRED: "Google 登入已逾時或已使用，請重新載入登入按鈕",
  GOOGLE_ACCOUNT_LINK_REQUIRED:
    "此 Email 已有 CareerOS 帳號，請先用密碼登入，再到偏好與連接綁定 Google",
  GOOGLE_ACCOUNT_MISMATCH: "請選擇目前 CareerOS 帳號已綁定的 Google 帳號",
  GOOGLE_ALREADY_LINKED:
    "這個 Google 帳號或 CareerOS 帳號已有其他綁定，請核對帳號",
  GOOGLE_REAUTH_REQUIRED: "請先在帳戶設定重新驗證 Google，再於五分鐘內完成操作",
  PASSWORD_REQUIRED_BEFORE_UNLINK:
    "請先設定登入密碼，避免解除 Google 後無法登入",
  ALREADY_SIGNED_IN: "你已經登入，請重新整理工作台",
  NOT_FOUND: "找不到資料或沒有存取權限",
  FILE_TYPE_OR_SIZE_NOT_ALLOWED: "支援文字、PDF、DOCX 與音檔，單檔最多 20 MB",
  SOURCE_WITHDRAWN_OR_EXPIRED: "履歷引用了已撤回或失效的經驗，請建立新版本",
  CAREER_REVISION_REQUIRED: "請先確認至少一項經驗",
  CONSENT_EXPIRED: "授權請求已過期，請回到你的 AI 助理重新連接",
  NETWORK_ERROR: "連線中斷，請確認網路後再試；送出前請先核對是否已保存",
  CAREER_JOB_SAMPLE_REQUIRED: "請先保存幾份目標職缺，讓分析有資料依據",
  AI_OUTPUT_INVALID: "AI 回傳內容未通過格式檢查，請查看任務後再決定是否重建",
  AI_OUTPUT_INCOMPLETE: "AI 輸出超過限制而未完成，請縮小輸入後建立新任務",
  AI_OUTPUT_REFUSED: "AI 供應商未提供這次結果，請檢查輸入內容",
  AI_MODE_DISABLED: "目前為手動模式，請先在設定切換 MCP 或 BYOK",
  APPLICATION_CLOSED: "這筆申請已有最終結果，無法用此事件覆蓋",
  STORAGE_QUOTA_REACHED: "已達私人附件空間上限（512 MB 或 2,000 個檔案）",
  AUDIO_INVALID_OR_OVER_3_MINUTES: "音檔無法解析或超過三分鐘，請裁剪或改用 WAV",
  EXPORT_BUSY_TRY_AGAIN: "正在產生另一份文件，請稍後重試",
  TRANSFER_GROUP_OWNER_FIRST: "請先移轉或刪除你擁有的小組",
  EVENT_CANNOT_BE_IN_FUTURE: "投遞時間不能在未來，請檢查日期與時間",
  RESUME_FILE_REQUIRED: "履歷附件僅支援 PDF 或 DOCX，單檔最多 20 MB",
  UNSAFE_URL: "請填寫不含帳號密碼的 http 或 https 職缺網址",
  MANUAL_JOB_DETAILS_CONFLICT:
    "此網址已對應其他職缺資料，請核對公司、職位與市場，或從既有申請更新",
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
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetch(base + "/api" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
      ...(method !== "GET"
        ? { "idempotency-key": idempotencyKey ?? crypto.randomUUID() }
        : {}),
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
