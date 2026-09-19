import React, {
  useEffect,
  useRef,
  useState,
  createContext,
  useContext,
} from "react";
import { Privacy } from "./privacy.js";
import { createRoot } from "react-dom/client";
import { api, base, message, ApiError } from "./api";
import "./styles.css";
import { GoogleLogin } from "./google-login";
type Row = Record<string, any>;
type Field = {
  name: string;
  label: string;
  type?: string;
  options?: { value: string; label: string }[];
  value?: any;
  required?: boolean;
  placeholder?: string;
  help?: string;
  accept?: string;
  emptyLabel?: string;
  visibleWhen?: { field: string; value: string };
};
const names: Record<string, string> = {
  dashboard: "求職總覽",
  experience: "我的經驗",
  career: "職涯導航",
  resumes: "履歷工作室",
  jobs: "找職缺",
  collections: "職缺分組",
  groups: "求職小組",
  applications: "投遞中心",
  interviews: "面試與面經",
  offers: "Offer 紀錄",
  tasks: "Agent 任務",
  settings: "偏好與連接",
};
const statuses: Record<string, string> = {
  preparing: "準備中",
  submitted: "已投遞",
  interviewing: "面試中",
  offer: "收到 Offer",
  accepted: "已接受",
  rejected: "未錄取",
  withdrawn: "已撤回",
  offer_declined: "已婉拒",
  invited: "已獲邀",
  scheduled: "已排定",
  completed: "已完成",
  cancelled: "已取消",
  queued: "等待執行",
  running: "執行中",
  waiting_client: "待你的 Claude 處理",
  succeeded: "完成",
  failed: "需要處理",
  received: "待決定",
  declined: "已婉拒",
  expired: "已失效",
  active: "已連接",
  needs_reauth: "需要重新連接",
};
const kinds: Record<string, string> = {
  work: "工作經驗",
  project: "專案",
  skill: "技能",
  education: "學歷",
  achievement: "成果",
  license: "證照",
  extract_experience: "整理經驗",
  generate_resume: "生成履歷",
  career_analysis: "職涯分析",
  search_jobs: "搜尋職缺",
  parse_document: "解析文件",
  transcribe: "語音轉錄",
  sync_google: "同步回覆",
};
const date = (d: any) => (d ? new Date(d).toLocaleDateString("zh-TW") : "—");
const localDateTime = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const options = (rows: Row[], label: (r: Row) => string) =>
  rows.map((r) => ({ value: r.id, label: label(r) }));
const Badge = ({ value }: { value: string }) => (
  <span
    className={
      "badge " +
      (["failed", "rejected", "needs_reauth"].includes(value) ? "warn" : "")
    }
  >
    {statuses[value] ?? value}
  </span>
);
const Empty = ({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) => (
  <div className="empty">
    <div className="empty-mark">C</div>
    <h3>{title}</h3>
    <p>{body}</p>
    {children}
  </div>
);
const Notice = ({ children }: { children: React.ReactNode }) => (
  <div className="notice">{children}</div>
);
type Modal = {
  title: string;
  intro?: string;
  fields: Field[];
  submit: string;
  action: (values: Row) => Promise<any>;
};
type Ctx = {
  user: Row;
  data: Row;
  reload: () => void;
  go: (r: string) => void;
  notify: (s: string) => void;
  run: (f: () => Promise<any>, success?: string) => Promise<any>;
  form: (m: Modal) => void;
};
const Context = createContext<Ctx>(null!);
const useApp = () => useContext(Context);
function FormDialog({ modal, close }: { modal: Modal; close: () => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [fieldValues, setFieldValues] = useState<Row>(() =>
    Object.fromEntries(
      modal.fields.map((f) => [
        f.name,
        f.value ?? (f.required ? (f.options?.[0]?.value ?? "") : ""),
      ]),
    ),
  );
  const formRef = useRef<HTMLFormElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    formRef.current
      ?.querySelector<HTMLInputElement>("input,textarea,select,button")
      ?.focus();
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) {
        e.preventDefault();
        close();
      }
      if (e.key === "Tab") {
        const items = Array.from(
          formRef.current
            ?.closest(".dialog")
            ?.querySelectorAll<HTMLElement>(
              "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]",
            ) ?? [],
        );
        const first = items[0],
          last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <header>
          <h2 id="dialog-title">{modal.title}</h2>
          <button
            className="icon-button"
            onClick={close}
            disabled={busy}
            aria-label="關閉"
          >
            ×
          </button>
        </header>
        {modal.intro && <p className="muted">{modal.intro}</p>}
        <form
          ref={formRef}
          onChange={(e) =>
            setFieldValues(
              Object.fromEntries(new FormData(e.currentTarget).entries()),
            )
          }
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const values = Object.fromEntries(
              new FormData(e.currentTarget).entries(),
            );
            for (const f of modal.fields) {
              if (f.type === "file") {
                const input = e.currentTarget.elements.namedItem(
                  f.name,
                ) as HTMLInputElement | null;
                if (input?.files?.[0]) values[f.name] = input.files[0];
              }
            }
            try {
              await modal.action(values);
              close();
            } catch (err) {
              setError(message(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {modal.fields
            .filter(
              (f) =>
                !f.visibleWhen ||
                fieldValues[f.visibleWhen.field] === f.visibleWhen.value,
            )
            .map((f) => (
              <label className="field" key={f.name}>
                <span>
                  {f.label}
                  {f.required ? " *" : ""}
                </span>
                {f.type === "textarea" ? (
                  <textarea
                    name={f.name}
                    defaultValue={f.value}
                    placeholder={f.placeholder}
                    required={f.required}
                    rows={6}
                    disabled={busy}
                  />
                ) : f.options ? (
                  <select
                    name={f.name}
                    defaultValue={f.value}
                    required={f.required}
                    disabled={busy}
                  >
                    {!f.required && (
                      <option value="">{f.emptyLabel ?? "不指定"}</option>
                    )}
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    name={f.name}
                    type={f.type ?? "text"}
                    defaultValue={f.value}
                    placeholder={f.placeholder}
                    required={f.required}
                    disabled={busy}
                    accept={f.accept}
                    step={f.type === "number" ? "any" : undefined}
                  />
                )}{" "}
                {f.help && <small>{f.help}</small>}
              </label>
            ))}
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <footer>
            <button
              type="button"
              className="secondary"
              onClick={close}
              disabled={busy}
            >
              取消
            </button>
            <button disabled={busy}>{busy ? "儲存中…" : modal.submit}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
function Auth({ onLogin }: { onLogin: (u: Row) => void }) {
  const [register, setRegister] = useState(false),
    [status, setStatus] = useState<Row>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const authForm = useRef<HTMLFormElement>(null);
  const invite = new URLSearchParams(location.hash.slice(1)).get("setup") ?? "";
  useEffect(() => {
    api("/auth/status").then((s) => {
      setStatus(s);
      if (s.bootstrapAvailable || invite) setRegister(true);
    });
  }, []);
  return (
    <main className="auth-page">
      <section className="auth-story">
        <div className="wordmark">
          CareerOS<span>你的職涯工作台</span>
        </div>
        <div>
          <p className="eyebrow">YOUR NEXT CHAPTER</p>
          <h1>
            每一段經驗，
            <br />
            都能通往
            <br />
            <em>新的可能。</em>
          </h1>
          <p>
            把經驗整理成你的底氣。
            <br />
            從第一份履歷，到下一個 offer，
            <br />
            每一步都清楚記錄。
          </p>
        </div>
        <div className="auth-foot">
          經驗庫 · 多版履歷 · 台灣 × 國際 · 私人小組
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <span className="badge">個人資料預設私人</span>
          <h2>{register ? "建立你的工作台" : "歡迎回到 CareerOS"}</h2>
          <p className="muted">
            {register
              ? "從真實的你開始，慢慢建立完整的職涯紀錄。"
              : "你的經驗、機會與下一步，都在這裡。"}
          </p>
          <form
            ref={authForm}
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              setBusy(true);
              setError("");
              const v = Object.fromEntries(new FormData(e.currentTarget));
              try {
                const r = await api(
                  "/auth/" + (register ? "register" : "login"),
                  "POST",
                  v,
                );
                onLogin(r.user);
                if (invite) location.hash = "dashboard";
              } catch (err) {
                setError(message(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {register && (
              <label className="field">
                <span>怎麼稱呼你</span>
                <input
                  name="name"
                  required
                  autoComplete="name"
                  placeholder="你的名字"
                />
              </label>
            )}
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
              />
            </label>
            <label className="field">
              <span>密碼</span>
              <input
                type="password"
                name="password"
                required
                minLength={register ? 12 : 1}
                maxLength={128}
                autoComplete={register ? "new-password" : "current-password"}
                placeholder={register ? "至少 12 個字元" : "輸入你的密碼"}
              />
            </label>
            {register && (
              <label className="field">
                <span>工作台邀請碼</span>
                <input
                  name="invite"
                  defaultValue={invite}
                  required={!status.registrationOpen}
                  autoComplete="off"
                  placeholder="由管理員提供"
                />
              </label>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button className="full" disabled={busy}>
              {busy ? "正在連接…" : register ? "建立工作台" : "進入工作台"}{" "}
              <span>→</span>
            </button>
          </form>
          {status.googleEnabled && (
            <>
              <div className="auth-divider">或使用 Google 帳號</div>
              <GoogleLogin
                clientId={status.googleClientId}
                intent="login"
                invite={() =>
                  (
                    authForm.current?.elements.namedItem(
                      "invite",
                    ) as HTMLInputElement | null
                  )?.value || invite
                }
                disabled={busy}
                onBusy={setBusy}
                onSuccess={(user) => {
                  onLogin(user);
                  if (invite) location.hash = "dashboard";
                }}
              />
              <p className="muted">
                <small>
                  首次建立工作台仍需邀請碼。Google 登入只讀取基本身份與 Email。
                </small>
              </p>
            </>
          )}
          <p className="muted">
            <a
              href={base + "/privacy"}
              target="_blank"
              rel="noopener noreferrer"
            >
              隱私與資料使用說明
            </a>
          </p>
          <button
            className="link"
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register ? "已有帳號？登入" : "有邀請碼？建立帳號"}
          </button>
          <small className="auth-privacy">
            履歷與面經由你決定是否分享。
            <br />
            AI 功能使用你自己的 Claude 或 API key。
          </small>
        </div>
      </section>
    </main>
  );
}
function Dashboard() {
  const { data: d, go, user } = useApp();
  return (
    <>
      <div className="welcome">
        <div>
          <p className="eyebrow">YOUR CAREER, IN MOTION</p>
          <h2>{user.name}，一步一步，靠近下一站。</h2>
          <p>把注意力放在新的機會，讓工作台記住每個進展。</p>
        </div>
        <button onClick={() => go("experience")}>＋ 補充我的經驗</button>
      </div>
      <div className="stats">
        {[
          ["已投遞", d.counts?.submitted ?? 0, "從已確認的申請開始"],
          ["獲邀面試", d.counts?.interviews ?? 0, "同一職缺多輪只計一次"],
          ["收到 Offer", d.counts?.offers ?? 0, "每一份進展都值得記錄"],
        ].map(([label, n, sub]) => (
          <article className="stat" key={label}>
            <span>{label}</span>
            <strong>{n}</strong>
            <small>{sub}</small>
          </article>
        ))}
      </div>
      <div className="columns">
        <section className="card">
          <div className="section-head">
            <h2>最近的機會</h2>
            <button className="link" onClick={() => go("applications")}>
              查看全部 →
            </button>
          </div>
          {d.recent?.length ? (
            d.recent.map((r: Row) => (
              <div className="list-row" key={r.id}>
                <div className="company-logo">{r.company.slice(0, 1)}</div>
                <div className="grow">
                  <strong>{r.company}</strong>
                  <p>{r.title}</p>
                </div>
                <Badge value={r.status} />
              </div>
            ))
          ) : (
            <Empty
              title="第一個機會，從你的經驗開始"
              body="先整理經驗，再生成履歷。找到喜歡的職缺時，所有準備都能接著使用。"
            >
              <button onClick={() => go("experience")}>建立經驗庫 →</button>
            </Empty>
          )}
        </section>
        <section className="card">
          <h2>接下來的面試</h2>
          {d.upcoming?.length ? (
            d.upcoming.map((i: Row) => (
              <div className="interview-item" key={i.id}>
                <span className="date-chip">{date(i.starts_at)}</span>
                <h3>{i.company}</h3>
                <p>
                  {i.title} · {i.round}
                </p>
                <Badge value={i.status} />
              </div>
            ))
          ) : (
            <p className="muted spacious">
              收到邀請後，在這裡安排每一輪面試。
              <br />
              面試練習會另外記錄。
            </p>
          )}
          <hr />
          <h3>待處理</h3>
          <button className="todo-row" onClick={() => go("experience")}>
            <span>經驗待確認</span>
            <strong>{d.pending?.facts ?? 0} →</strong>
          </button>
          <button className="todo-row" onClick={() => go("tasks")}>
            <span>Agent 任務與更新</span>
            <strong>{d.pending?.tasks ?? 0} →</strong>
          </button>
        </section>
      </div>
    </>
  );
}
function Experience() {
  const { data: d, form, run, reload, go, user, notify } = useApp();
  const [source, setSource] = useState<Row | null>(null),
    [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      recorder.current?.state === "recording" && recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  const addSource = () =>
    form({
      title: "把你的經驗說完整",
      intro:
        "可以很零散。做過的工作、專案、遇到的挑戰、得到的成果，都先保留下來。",
      fields: [
        { name: "title", label: "這段經驗的標題", required: true },
        {
          name: "content",
          label: "原始經驗",
          type: "textarea",
          required: true,
          placeholder: "例如：我在上一份工作負責…",
        },
      ],
      submit: "保存原始素材",
      action: (v) =>
        run(
          () => api("/sources", "POST", { ...v, kind: "text" }),
          "已保存，可以交給 AI 整理或自行建立經驗",
        ),
    });
  const addFact = () =>
    form({
      title: "新增已確認的經驗",
      intro: "只填你確實做過、可以說明的事情。未知數字留白。",
      fields: [
        {
          name: "kind",
          label: "類型",
          required: true,
          options: Object.entries(kinds)
            .slice(0, 6)
            .map(([value, label]) => ({ value, label })),
        },
        { name: "title", label: "標題", required: true },
        {
          name: "content",
          label: "經驗與成果",
          type: "textarea",
          required: true,
        },
      ],
      submit: "確認並加入經驗庫",
      action: (v) =>
        run(
          () =>
            api("/facts", "POST", { fact: v, expectedRevision: d.revision }),
          "經驗庫已更新",
        ),
    });
  const upload = async (file: File) => {
    const f = new FormData();
    f.append("file", file);
    const r = await run(
      () => api("/assets", "POST", f),
      "已保存檔案；PDF/DOCX 會在背景解析",
    );
    setSource(r.source);
  };
  const record = async () => {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
      const rec = new MediaRecorder(stream.current, { mimeType: mime });
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        setRecording(false);
        stream.current?.getTracks().forEach((t) => t.stop());
        if (timer.current) clearTimeout(timer.current);
        void upload(
          new File(
            chunks,
            "經驗錄音." + (mime.includes("webm") ? "webm" : "m4a"),
            { type: mime },
          ),
        );
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
      timer.current = setTimeout(() => rec.stop(), 180000);
    } catch {
      notify("無法使用麥克風，仍可打字或上傳音檔。");
    }
  };
  const active = (d.facts ?? []).filter((f: Row) => !f.revoked_at);
  const pending = active.filter((f: Row) => !f.confirmed);
  return (
    <>
      <div className="action-bar">
        <div>
          <Badge value={`版本 ${d.revision ?? 0}`} />
          <span className="muted"> 你的履歷，都從同一份經驗開始。</span>
        </div>
        <div className="actions">
          <a className="button secondary" href={base + "/api/career/markdown"}>
            匯出 Markdown
          </a>
          <button onClick={addFact}>＋ 新增經驗</button>
        </div>
      </div>
      <section className="capture card">
        <div>
          <p className="eyebrow">START WITH YOUR STORY</p>
          <h2>先把經驗留下來，不用急著寫成履歷。</h2>
          <p className="muted">
            文字、錄音、舊履歷都可以。原始素材會保留，AI 整理後由你確認。
          </p>
          <div className="actions">
            <button onClick={addSource}>輸入一段經驗</button>
            <button className="secondary" onClick={record}>
              {recording ? "● 停止並保存" : "語音記錄"}
            </button>
            <label className="button secondary">
              上傳檔案
              <input
                type="file"
                hidden
                accept=".txt,.md,.pdf,.docx,.mp3,.wav,.m4a,.webm"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <small>
            每段錄音最多 3 分鐘；檔案最多 20 MB。自動轉錄使用你的 OpenAI API
            key。
          </small>
        </div>
        <div className="capture-symbol">
          經驗
          <br />
          <span>→ 可能性</span>
        </div>
      </section>
      {pending.length > 0 && (
        <Notice>
          <strong>{pending.length} 項經驗待你確認</strong>
          <p>
            確認前請核對日期、數字、職稱與技能；這些內容尚不會直接用於投遞。
          </p>
          <button
            onClick={() =>
              run(
                () =>
                  api("/facts/confirm", "POST", {
                    ids: pending.map((f: Row) => f.id),
                    expectedRevision: d.revision,
                  }),
                "已確認選列經驗",
              )
            }
          >
            我已核對下方待確認內容
          </button>
        </Notice>
      )}
      <div className="columns">
        <section>
          <div className="section-head">
            <h2>我的經驗資料庫</h2>
            <span className="muted">{active.length} 項紀錄</span>
          </div>
          {active.length ? (
            active.map((f: Row) => (
              <article className="card fact-card" key={f.id}>
                <div className="section-head">
                  <Badge value={kinds[f.kind] ?? f.kind} />
                  <Badge value={f.confirmed ? "本人已確認" : "待確認"} />
                </div>
                <h3>{f.title}</h3>
                <p className="preserve">{f.content}</p>
                <div className="section-head">
                  <small>
                    來源：{f.source_id ? "原始素材" : "本人輸入"} ·{" "}
                    {date(f.created_at)}
                  </small>
                  <button
                    className="link danger"
                    onClick={() =>
                      form({
                        title: "撤回這項經驗",
                        intro:
                          "未來投遞不能再使用這項經驗；過去投遞的文件仍保留。",
                        fields: [],
                        submit: "撤回經驗",
                        action: () =>
                          run(() =>
                            api("/facts/" + f.id + "/revoke", "POST", {
                              expectedRevision: d.revision,
                            }),
                          ),
                      })
                    }
                  >
                    撤回
                  </button>
                </div>
              </article>
            ))
          ) : (
            <div className="card">
              <Empty
                title="你的經驗，值得好好整理"
                body="先新增一段素材，或直接建立一項已確認的經驗。"
              />
            </div>
          )}
        </section>
        <aside className="card">
          <h2>原始素材</h2>
          {d.sources?.length ? (
            d.sources.map((s: Row) => (
              <button
                className={
                  "source-row " + (source?.id === s.id ? "selected" : "")
                }
                key={s.id}
                onClick={() => setSource(s)}
              >
                <strong>{s.title}</strong>
                <small>
                  {date(s.created_at)} ·{" "}
                  {s.kind === "audio"
                    ? "音檔"
                    : s.kind === "file"
                      ? "文件"
                      : "文字"}
                </small>
              </button>
            ))
          ) : (
            <p className="muted">原文、檔案與逐字稿會放在這裡。</p>
          )}
          {source && (
            <div className="source-detail">
              <h3>{source.title}</h3>
              <p className="preserve excerpt">
                {source.content ||
                  "檔案已保存。文件解析或語音轉錄完成後，這裡會顯示內容。"}
              </p>
              {source.asset_id && (
                <a href={base + "/api/assets/" + source.asset_id}>下載原檔</a>
              )}
              <div className="stack">
                {source.content ? (
                  <button
                    onClick={() =>
                      run(
                        () =>
                          api("/tasks", "POST", {
                            kind: "extract_experience",
                            input: { sourceId: source.id },
                          }),
                        user.settings.mode === "byok"
                          ? "已排入整理任務"
                          : "任務已建立，請到你的 Claude 處理",
                      )
                    }
                  >
                    整理這段經驗
                  </button>
                ) : source.kind === "audio" ? (
                  <button
                    onClick={() =>
                      run(
                        () =>
                          api("/tasks", "POST", {
                            kind: "transcribe",
                            input: { sourceId: source.id },
                          }),
                        "轉錄任務已建立",
                      )
                    }
                  >
                    轉成逐字稿
                  </button>
                ) : null}
                <button className="secondary" onClick={() => go("tasks")}>
                  查看 Agent 任務
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
function Resumes() {
  const { data: d, user, run, form, notify, go } = useApp();
  const [selected, setSelected] = useState<Row | null>(null);
  const create = () =>
    form({
      title: "生成一份新的履歷",
      intro: "從已確認經驗生成；新文字經你核對後才能用於投遞。",
      fields: [
        {
          name: "title",
          label: "履歷方向",
          required: true,
          placeholder: "例如：產品經理 · 國際職缺",
        },
        {
          name: "language",
          label: "語言",
          required: true,
          options: [
            { value: "zh-TW", label: "繁體中文" },
            { value: "en", label: "English" },
          ],
        },
      ],
      submit: "建立生成任務",
      action: (v) =>
        run(
          () => api("/tasks", "POST", { kind: "generate_resume", input: v }),
          "已建立任務，可在 Agent 任務查看進度",
        ),
    });
  const manual = async () => {
    const c = await api("/career");
    const facts = c.facts.filter((f: Row) => f.confirmed && !f.revoked_at);
    if (!facts.length) {
      notify("請先確認至少一項經驗");
      return;
    }
    form({
      title: "用已確認經驗建立履歷",
      fields: [
        { name: "title", label: "履歷名稱", required: true, value: "我的履歷" },
        {
          name: "language",
          label: "語言",
          required: true,
          options: [
            { value: "zh-TW", label: "繁體中文" },
            { value: "en", label: "English" },
          ],
        },
      ],
      submit: "建立可編輯草稿",
      action: (v) =>
        run(() =>
          api("/resumes", "POST", {
            ...v,
            careerRevision: c.revision,
            blocks: facts.map((f: Row) => ({
              heading: f.title,
              text: f.content,
              factIds: [f.id],
            })),
          }),
        ),
    });
  };
  const edit = (r: Row) =>
    form({
      title: "編輯並另存新版本",
      intro: "原有版本與歷史投遞不會被覆寫。段落繼續保留原經驗引用。",
      fields: [
        { name: "title", label: "版本名稱", value: r.title, required: true },
        ...r.blocks.map((b: Row, i: number) => ({
          name: "block" + i,
          label: b.heading,
          type: "textarea",
          value: b.text,
          required: true,
        })),
      ],
      submit: "另存新版本",
      action: (v) =>
        run(
          () =>
            api("/resumes", "POST", {
              title: v.title,
              language: r.language,
              careerRevision: r.career_revision,
              jobId: r.job_id,
              parentId: r.id,
              blocks: r.blocks.map((b: Row, i: number) => ({
                ...b,
                text: v["block" + i],
              })),
            }),
          "新版本已保存",
        ),
    });
  return (
    <>
      <div className="action-bar">
        <p className="muted">同一份真實經驗，呈現不同的職涯方向。</p>
        <div className="actions">
          <button className="secondary" onClick={manual}>
            從經驗直接建立
          </button>
          <button onClick={create}>＋ AI 生成履歷</button>
        </div>
      </div>
      {d.items?.length ? (
        <div className="resume-layout">
          <div className="resume-list">
            {d.items.map((r: Row) => (
              <button
                className={
                  "resume-card " + (selected?.id === r.id ? "selected" : "")
                }
                key={r.id}
                onClick={() => setSelected(r)}
              >
                <div className="resume-mini">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <strong>{r.title}</strong>
                <span>
                  {r.language === "en" ? "English" : "繁體中文"} ·{" "}
                  {date(r.created_at)}
                </span>
                <Badge
                  value={r.validation.eligible ? "可用於投遞" : "待核對"}
                />
                {r.parent_id && <small>另存的新版本</small>}
              </button>
            ))}
          </div>
          <section className="card">
            {selected ? (
              <>
                <div className="section-head">
                  <h2>履歷預覽</h2>
                  <button className="secondary" onClick={() => edit(selected)}>
                    編輯新版本
                  </button>
                </div>
                <div className="resume-paper">
                  <h1>{user.name}</h1>
                  <p>{user.email}</p>
                  {selected.blocks.map((b: Row, i: number) => (
                    <section key={i}>
                      <h2>{b.heading}</h2>
                      <p className="preserve">{b.text}</p>
                      <small className="source-hint">
                        依據 {b.factIds.length} 項經驗
                      </small>
                    </section>
                  ))}
                </div>
                <div className="actions export-actions">
                  <a
                    className="button secondary"
                    href={base + "/api/resumes/" + selected.id + "/export/pdf"}
                  >
                    下載 PDF
                  </a>
                  <a
                    className="button secondary"
                    href={base + "/api/resumes/" + selected.id + "/export/docx"}
                  >
                    下載 DOCX
                  </a>
                  <a
                    className="button secondary"
                    href={base + "/api/resumes/" + selected.id + "/markdown"}
                  >
                    Markdown
                  </a>
                  {!selected.approved_at && (
                    <button
                      onClick={() =>
                        form({
                          title: "確認這份履歷",
                          intro:
                            "請逐段核對：日期、數字、職稱、技能與所有敘述均與你的真實經驗相符。系統會保留本次確認。",
                          fields: [],
                          submit: "我已核對，確認內容",
                          action: async () => {
                            await run(
                              () =>
                                api(
                                  "/resumes/" + selected.id + "/approve",
                                  "POST",
                                  {},
                                ),
                              "履歷已確認",
                            );
                            setSelected(null);
                          },
                        })
                      }
                    >
                      確認履歷內容
                    </button>
                  )}
                </div>
              </>
            ) : (
              <Empty
                title="選一份履歷，看看它的故事"
                body="在左側查看不同方向與版本，也能預覽、編輯及下載。"
              />
            )}
          </section>
        </div>
      ) : (
        <section className="card">
          <Empty
            title="一份經驗，不只一種可能"
            body="先建立經驗库，再產生適合不同職類與語言的履歷。"
          >
            <div className="actions">
              <button onClick={create}>生成第一份履歷</button>
              <button className="secondary" onClick={() => go("experience")}>
                前往經驗庫
              </button>
            </div>
          </Empty>
        </section>
      )}
    </>
  );
}
function Jobs() {
  const { data: d, run, form, go } = useApp();
  const [q, setQ] = useState(""),
    [market, setMarket] = useState(""),
    [detail, setDetail] = useState<Row | null>(null);
  const jobFields: Field[] = [
    { name: "title", label: "職位名稱", required: true },
    { name: "company", label: "公司", required: true },
    { name: "location", label: "工作地點" },
    {
      name: "market",
      label: "市場",
      required: true,
      options: [
        { value: "TW", label: "台灣" },
        { value: "US", label: "美國" },
        { value: "INTL", label: "國際" },
      ],
    },
    { name: "url", label: "原始職缺網址", type: "url" },
    {
      name: "description",
      label: "職缺描述",
      type: "textarea",
      required: true,
    },
  ];
  const search = () =>
    form({
      title: "搜尋來源職缺",
      intro:
        "從企業公開職涯頁取得最新職缺。可先選公司，再依市場與關鍵字篩選；其他平台也可貼上職缺描述匯入。",
      fields: [
        {
          name: "source",
          label: "搜尋哪裡的機會",
          required: true,
          options: [
            { value: "lever:Gogolook", label: "Gogolook（台灣與海外）" },
            { value: "lever:shopback-2", label: "ShopBack（台灣與海外）" },
            { value: "greenhouse:figma", label: "Figma（美國與海外）" },
            { value: "greenhouse:stripe", label: "Stripe（美國與海外）" },
            { value: "arbeitnow:", label: "Arbeitnow（國際職缺）" },
          ],
        },
        {
          name: "query",
          label: "關鍵字",
          placeholder: "Engineer、Design、產品",
        },
        {
          name: "market",
          label: "市場篩選",
          required: true,
          options: [
            { value: "INTL", label: "國際 / 不限" },
            { value: "TW", label: "台灣" },
            { value: "US", label: "美國" },
          ],
        },
      ],
      submit: "啟動搜尋",
      action: (v) =>
        run(() => {
          const [provider, board] = v.source.split(":");
          return api("/tasks", "POST", {
            kind: "search_jobs",
            input: { provider, board, query: v.query, market: v.market },
          });
        }, "搜尋已開始，結果將保存到職缺池"),
    });
  const rows = (d.items ?? []).filter(
    (j: Row) =>
      (!q ||
        (j.title + j.company + j.description)
          .toLowerCase()
          .includes(q.toLowerCase())) &&
      (!market || j.market === market),
  );
  const apply = async (j: Row) => {
    const resumes = await api("/resumes");
    form({
      title: "加入投遞中心",
      intro: "建立申請草稿並連結履歷。這個步驟不會對外送出。",
      fields: [
        {
          name: "resumeId",
          label: "使用履歷",
          options: options(
            resumes.items,
            (r) =>
              r.title + (r.validation.eligible ? " · 已確認" : " · 待核對"),
          ),
        },
      ],
      submit: "建立申請草稿",
      action: (v) =>
        run(
          () =>
            api("/applications", "POST", {
              jobId: j.id,
              ...(v.resumeId ? { resumeId: v.resumeId } : {}),
            }),
          "已加入投遞中心",
        ),
    });
  };
  const collect = async (j: Row) => {
    const c = await api("/collections");
    if (!c.items.length) {
      form({
        title: "建立分組並加入職缺",
        fields: [{ name: "name", label: "分組名稱", required: true }],
        submit: "建立分組",
        action: async (v) => {
          const r = await api("/collections", "POST", v);
          await run(() =>
            api("/collections/" + r.id + "/jobs", "POST", { jobId: j.id }),
          );
        },
      });
    } else
      form({
        title: "加入職缺分組",
        fields: [
          {
            name: "collectionId",
            label: "分組",
            required: true,
            options: options(c.items, (r) => r.name),
          },
        ],
        submit: "加入",
        action: (v) =>
          run(() =>
            api("/collections/" + v.collectionId + "/jobs", "POST", {
              jobId: j.id,
            }),
          ),
      });
  };
  return (
    <>
      <div className="action-bar">
        <div className="filters">
          <input
            aria-label="搜尋已保存職缺"
            placeholder="搜尋職位、公司或技能…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            aria-label="市場"
            value={market}
            onChange={(e) => setMarket(e.target.value)}
          >
            <option value="">所有市場</option>
            <option value="TW">台灣</option>
            <option value="US">美國</option>
            <option value="INTL">國際</option>
          </select>
        </div>
        <div className="actions">
          <button
            className="secondary"
            onClick={() =>
              form({
                title: "匯入職缺",
                fields: jobFields,
                submit: "保存職缺",
                action: (v) => run(() => api("/jobs", "POST", v)),
              })
            }
          >
            貼上職缺
          </button>
          <button onClick={search}>搜尋新機會 →</button>
        </div>
      </div>
      <div className="section-head">
        <span className="muted">{rows.length} 個已保存機會</span>
        <small>所有來源保留原文；履歷依據你的經驗客製。</small>
      </div>
      {rows.length ? (
        <div className="job-grid">
          {rows.map((j: Row) => (
            <article className="card job-card" key={j.id}>
              <div className="section-head">
                <div className="company-logo">{j.company.slice(0, 1)}</div>
                <Badge value={j.application_status ?? "尚未申請"} />
              </div>
              <p className="company-name">{j.company}</p>
              <h2>{j.title}</h2>
              <p className="muted">
                {j.location || "地點待確認"} · {j.market}
              </p>
              <p className="excerpt">{j.description.slice(0, 160)}</p>
              <div className="section-head">
                <small>
                  {j.provider} · {date(j.updated_at)}
                </small>
                <button className="link" onClick={() => setDetail(j)}>
                  查看詳情 →
                </button>
              </div>
              <div className="actions">
                <button onClick={() => apply(j)}>準備申請</button>
                <button className="secondary" onClick={() => collect(j)}>
                  加入分組
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="card">
          <Empty
            title="找到下一個值得投入的機會"
            body="搜尋企業官網職缺，或把台灣與國際平台的職缺描述貼進來。"
          >
            <button onClick={search}>開始搜尋</button>
          </Empty>
        </section>
      )}
      {detail && (
        <div className="overlay">
          <section className="dialog wide" role="dialog" aria-modal="true">
            <header>
              <div>
                <small>{detail.company}</small>
                <h2>{detail.title}</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setDetail(null)}
                aria-label="關閉"
              >
                ×
              </button>
            </header>
            <p>
              {detail.location} · {detail.market}
            </p>
            <div className="preserve job-description">{detail.description}</div>
            <footer>
              {detail.url && (
                <a
                  className="button secondary"
                  href={detail.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  原始職缺 ↗
                </a>
              )}
              <button
                className="secondary"
                onClick={() => {
                  void run(
                    () =>
                      api("/tasks", "POST", {
                        kind: "generate_resume",
                        input: {
                          jobId: detail.id,
                          title: detail.title,
                          language: detail.market === "TW" ? "zh-TW" : "en",
                        },
                      }),
                    "專用履歷任務已建立",
                  );
                  setDetail(null);
                }}
              >
                產生專用履歷
              </button>
              <button
                onClick={() => {
                  void apply(detail);
                  setDetail(null);
                }}
              >
                準備申請
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

function Applications() {
  const { data: d, run, form, go } = useApp();
  const [detail, setDetail] = useState<Row | null>(null);
  const rows = d.items ?? [];
  const record = async () => {
    const resumes = await api("/resumes");
    const fileHashes = new WeakMap<File, string>();
    const keys = new Map<string, string>();
    form({
      title: "手動新增已投遞",
      intro:
        "記下你已經送出的申請。可以使用站內履歷、附上外部檔案，或先只記錄履歷名稱。",
      fields: [
        { name: "company", label: "公司", required: true },
        { name: "title", label: "職位名稱", required: true },
        {
          name: "market",
          label: "市場",
          required: true,
          value: "TW",
          options: [
            { value: "TW", label: "台灣" },
            { value: "US", label: "美國" },
            { value: "INTL", label: "其他／國際" },
          ],
        },
        {
          name: "occurredAt",
          label: "投遞時間",
          type: "datetime-local",
          required: true,
          value: localDateTime(),
        },
        {
          name: "channel",
          label: "投遞管道",
          placeholder: "例如 104、LinkedIn、公司官網、Email",
        },
        {
          name: "resumeId",
          label: "使用的站內履歷",
          emptyLabel: "外部履歷／未記錄",
          options: options(resumes.items, (r) => r.title),
          help: "選擇你當時實際使用的版本。",
        },
        {
          name: "resumeFile",
          label: "上傳當時的履歷",
          type: "file",
          accept: ".pdf,.docx",
          visibleWhen: { field: "resumeId", value: "" },
          help: "選填，PDF／DOCX，最多 20 MB。檔案僅自己可見。",
        },
        {
          name: "externalResumeName",
          label: "外部履歷名稱",
          placeholder: "例如：產品經理履歷 v3",
          visibleWhen: { field: "resumeId", value: "" },
          help: "未上傳檔案也可以只填名稱；上傳後留白則使用檔名。",
        },
        {
          name: "url",
          label: "職缺網址",
          type: "url",
          placeholder: "https://…",
        },
        {
          name: "notes",
          label: "投遞備註",
          type: "textarea",
          placeholder: "例如：透過朋友內推，已收到系統確認信。",
        },
      ],
      submit: "確認已投遞，儲存紀錄",
      action: (v) =>
        run(async () => {
          if (new Date(v.occurredAt).getTime() > Date.now() + 60000)
            throw new ApiError("EVENT_CANNOT_BE_IN_FUTURE");
          let fileHash: string | undefined;
          const file = v.resumeFile;
          if (!v.resumeId && file instanceof File && file.size) {
            if (
              !/\.(pdf|docx)$/i.test(file.name) ||
              file.size > 20 * 1024 * 1024
            )
              throw new ApiError("RESUME_FILE_REQUIRED");
            fileHash = fileHashes.get(file);
            if (!fileHash) {
              const digest = await crypto.subtle.digest(
                "SHA-256",
                await file.arrayBuffer(),
              );
              fileHash = Array.from(new Uint8Array(digest), (b) =>
                b.toString(16).padStart(2, "0"),
              ).join("");
              fileHashes.set(file, fileHash);
            }
          }
          const payload = {
            company: v.company,
            title: v.title,
            market: v.market,
            url: v.url,
            occurredAt: new Date(v.occurredAt).toISOString(),
            channel: v.channel,
            notes: v.notes,
            ...(v.resumeId
              ? { resumeId: v.resumeId }
              : {
                  externalResumeName: v.externalResumeName || "",
                }),
          };
          const encoded = JSON.stringify({
            payload,
            fileHash,
            name: fileHash ? file.name : null,
          });
          let body: unknown = payload;
          if (fileHash) {
            const multipart = new FormData();
            multipart.append("metadata", JSON.stringify(payload));
            multipart.append("file", file);
            body = multipart;
          }
          if (!keys.has(encoded)) keys.set(encoded, crypto.randomUUID());
          return api("/applications/manual", "POST", body, keys.get(encoded));
        }, "已新增投遞紀錄，可繼續追蹤面試與 offer"),
    });
  };
  const edit = (a: Row) =>
    form({
      title: "更新申請進度",
      intro:
        "請只記錄已發生的事情。已投遞需要你確實完成送出；準備履歷不算已投遞。",
      fields: [
        {
          name: "type",
          label: "發生的事情",
          required: true,
          options: [
            { value: "submitted", label: "已確認送出" },
            { value: "interview_invited", label: "收到正式面試邀請" },
            { value: "rejected", label: "收到未錄取通知" },
            { value: "withdrawn", label: "我已撤回申請" },
          ],
        },
        {
          name: "occurredAt",
          label: "發生時間",
          type: "datetime-local",
          required: true,
          value: localDateTime(),
        },
        { name: "notes", label: "來源與備註", type: "textarea" },
      ],
      submit: "確認更新",
      action: (v) =>
        run(
          () =>
            api("/applications/events", "POST", {
              ...v,
              applicationId: a.id,
              expectedVersion: a.version,
              occurredAt: new Date(v.occurredAt).toISOString(),
            }),
          "申請進度已更新",
        ),
    });
  const chooseResume = async (a: Row) => {
    const r = await api("/resumes");
    form({
      title: "選擇這次使用的履歷",
      fields: [
        {
          name: "resumeId",
          label: "履歷版本",
          required: true,
          options: options(
            r.items,
            (r) =>
              r.title + (r.validation.eligible ? " · 已確認" : " · 待核對"),
          ),
        },
      ],
      submit: "保存版本",
      action: (v) =>
        run(() =>
          api("/applications/" + a.id + "/resume", "POST", {
            ...v,
            expectedVersion: a.version,
          }),
        ),
    });
  };
  return (
    <>
      <Notice>
        <strong>自己投遞，也能集中追蹤</strong>
        <p>
          已在求職平台、公司官網或 Email
          送出的申請，可以直接手動新增。記下當時的履歷與投遞時間，後續面試、面經與
          offer 都接在同一筆紀錄。
        </p>
      </Notice>
      <div className="pipeline">
        {[
          ["準備中", rows.filter((r: Row) => r.status === "preparing").length],
          ["已投遞", rows.filter((r: Row) => r.submitted_at).length],
          [
            "面試中",
            rows.filter((r: Row) => r.status === "interviewing").length,
          ],
          [
            "Offer",
            rows.filter((r: Row) => ["offer", "accepted"].includes(r.status))
              .length,
          ],
        ].map(([label, n]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{n}</strong>
          </div>
        ))}
      </div>
      <section className="card">
        <div className="section-head">
          <h2>我的申請</h2>
          <div className="actions">
            <button className="secondary" onClick={() => go("jobs")}>
              從職缺準備申請
            </button>
            <button onClick={record}>＋ 手動新增已投遞</button>
          </div>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>公司與職位</th>
                  <th>履歷版本</th>
                  <th>進度</th>
                  <th>投遞日期</th>
                  <th>下一步</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a: Row) => (
                  <tr key={a.id}>
                    <td>
                      <button
                        className="text-button"
                        onClick={async () =>
                          setDetail(await api("/applications/" + a.id))
                        }
                      >
                        <strong>{a.company}</strong>
                        <span>
                          {a.title} ·{" "}
                          {(
                            { TW: "台灣", US: "美國", INTL: "國際" } as Record<
                              string,
                              string
                            >
                          )[a.market] ?? a.market}
                        </span>
                      </button>
                    </td>
                    <td>
                      {a.resume_title ||
                        a.external_resume_name ||
                        (a.submitted_at ? (
                          "未記錄履歷"
                        ) : (
                          <button
                            className="link"
                            onClick={() => chooseResume(a)}
                          >
                            選擇履歷
                          </button>
                        ))}
                    </td>
                    <td>
                      <Badge value={a.status} />
                    </td>
                    <td>
                      {date(a.submitted_at)}
                      {a.submission_channel && (
                        <small>{a.submission_channel}</small>
                      )}
                    </td>
                    <td>
                      <div className="actions">
                        {!a.submitted_at && (
                          <button
                            className="secondary small"
                            onClick={() =>
                              run(
                                () =>
                                  api(
                                    "/applications/" + a.id + "/prepare",
                                    "POST",
                                    {},
                                  ),
                                "已固定這次職缺、履歷與答案快照",
                              )
                            }
                          >
                            保存投遞快照
                          </button>
                        )}
                        <button className="small" onClick={() => edit(a)}>
                          更新
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="每份申請，都有自己的時間軸"
            body="已經自行投遞？點上方「手動新增已投遞」就能記錄，不需要先建立職缺或履歷。"
          >
            <button onClick={() => go("jobs")}>找職缺 →</button>
          </Empty>
        )}
      </section>
      {detail && (
        <div className="overlay">
          <section className="dialog wide" role="dialog" aria-modal="true">
            <header>
              <h2>
                {detail.job.company} · {detail.job.title}
              </h2>
              <button
                className="icon-button"
                onClick={() => setDetail(null)}
                aria-label="關閉"
              >
                ×
              </button>
            </header>
            <Badge value={detail.application.status} />
            <h3>事件時間軸</h3>
            {detail.events.length ? (
              detail.events.map((e: Row) => (
                <div className="timeline" key={e.id}>
                  <strong>{statuses[e.type] ?? e.type}</strong>
                  <small>
                    {date(e.occurred_at)} ·{" "}
                    {e.source === "user_reported" ? "本人補登" : "系統事件"}
                  </small>
                  <p>{e.payload.notes}</p>
                </div>
              ))
            ) : (
              <p className="muted">
                尚無事件。準備完成後，在原站完成申請並記錄結果。
              </p>
            )}
            <h3>已保存的投遞快照</h3>
            {detail.dossiers.map((s: Row) => (
              <div className="list-row" key={s.id}>
                <div className="grow">
                  <strong>
                    {s.snapshot.resume?.title ||
                      s.snapshot.resumeLabel ||
                      s.snapshot.externalResume?.name ||
                      "未記錄履歷"}
                  </strong>
                  <small>
                    {date(s.snapshot.submittedAt || s.created_at)}
                    {s.snapshot.submissionChannel
                      ? " · " + s.snapshot.submissionChannel
                      : ""}{" "}
                    ·{" "}
                    {s.snapshot.source === "user_reported"
                      ? "本人補登"
                      : "準備快照"}
                  </small>
                </div>
                {(s.snapshot.resume || s.snapshot.externalResume) && (
                  <a
                    className="button secondary"
                    href={
                      s.snapshot.resume
                        ? base +
                          "/api/resumes/" +
                          s.snapshot.resume.id +
                          "/export/pdf"
                        : base + "/api/assets/" + s.snapshot.externalResume.id
                    }
                  >
                    {s.snapshot.resume ? "當時履歷 PDF" : "下載當時履歷"}
                  </a>
                )}
              </div>
            ))}
            {detail.job.url && (
              <a
                className="button"
                href={detail.job.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                查看原始職缺 ↗
              </a>
            )}
          </section>
        </div>
      )}
    </>
  );
}
function Interviews() {
  const { data: d, form, run } = useApp();
  const [tab, setTab] = useState("interviews");
  const add = async () => {
    if (tab === "prep") {
      form({
        title: "建立面試準備",
        intro: "準備紀錄不會計入正式面試數。",
        fields: [
          { name: "title", label: "準備主題", required: true },
          { name: "notes", label: "目標與練習內容", type: "textarea" },
        ],
        submit: "保存準備紀錄",
        action: (v) => run(() => api("/preparations", "POST", v)),
      });
      return;
    }
    const a = await api("/applications");
    if (tab === "notes") {
      form({
        title: "記錄這次面試",
        intro: "原始心得預設私人。主觀感受和對方明確回饋請分開描述。",
        fields: [
          { name: "title", label: "面經標題", required: true },
          {
            name: "applicationId",
            label: "關聯申請",
            options: options(a.items, (r) => r.company + " · " + r.title),
          },
          {
            name: "content",
            label: "題目、回答、回饋與下一步",
            type: "textarea",
            required: true,
          },
        ],
        submit: "保存面經",
        action: (v) =>
          run(() =>
            api("/notes", "POST", {
              ...v,
              applicationId: v.applicationId || null,
            }),
          ),
      });
      return;
    }
    form({
      title: "新增正式面試",
      fields: [
        {
          name: "applicationId",
          label: "申請",
          required: true,
          options: options(a.items, (r) => r.company + " · " + r.title),
        },
        {
          name: "round",
          label: "輪次",
          required: true,
          placeholder: "例如：第一輪 · HR",
        },
        {
          name: "status",
          label: "狀態",
          required: true,
          options: [
            { value: "invited", label: "收到邀請，尚未排定" },
            { value: "scheduled", label: "已排定時間" },
            { value: "completed", label: "已完成" },
          ],
        },
        { name: "startsAt", label: "面試時間", type: "datetime-local" },
        { name: "notes", label: "形式與備註", type: "textarea" },
      ],
      submit: "確認新增面試",
      action: (v) =>
        run(() =>
          api("/interviews", "POST", {
            ...v,
            startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : null,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        ),
    });
  };
  const upload = async (file: File) => {
    const a = await api("/applications");
    const f = new FormData();
    f.append("file", file);
    const asset = await run(
      () => api("/assets", "POST", f),
      "原始面經檔案已保存",
    );
    form({
      title: "把檔案連到面經",
      fields: [
        { name: "title", label: "面經標題", required: true, value: file.name },
        {
          name: "applicationId",
          label: "關聯申請",
          options: options(a.items, (r) => r.company + " · " + r.title),
        },
        {
          name: "content",
          label: "心得或簡短說明",
          type: "textarea",
          required: true,
        },
      ],
      submit: "保存面經與附件",
      action: (v) =>
        run(() =>
          api("/notes", "POST", {
            ...v,
            applicationId: v.applicationId || null,
            assetId: asset.asset.id,
          }),
        ),
    });
  };
  return (
    <>
      <div className="action-bar">
        <div className="tabs">
          {[
            ["interviews", "正式面試"],
            ["notes", "我的面經"],
            ["prep", "面試準備"],
          ].map(([k, v]) => (
            <button
              className={tab === k ? "active" : ""}
              key={k}
              onClick={() => setTab(k)}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="actions">
          {tab === "notes" && (
            <label className="button secondary">
              上傳面經
              <input
                hidden
                type="file"
                accept=".txt,.md,.pdf,.docx"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                }}
              />
            </label>
          )}
          <button onClick={add}>
            ＋{" "}
            {tab === "notes"
              ? "記面經"
              : tab === "prep"
                ? "新增準備"
                : "新增面試"}
          </button>
        </div>
      </div>
      {tab === "interviews" ? (
        d.items?.length ? (
          <div className="job-grid">
            {d.items.map((i: Row) => (
              <article className="card" key={i.id}>
                <div className="section-head">
                  <span className="date-chip">{date(i.starts_at)}</span>
                  <Badge value={i.status} />
                </div>
                <h2>{i.company}</h2>
                <p>{i.title}</p>
                <p className="muted">
                  {i.round} · {i.timezone}
                </p>
                <p className="preserve">{i.notes}</p>
                <button
                  className="secondary"
                  onClick={() =>
                    form({
                      title: "更新這輪面試",
                      intro: "改期保留同一輪次與變更紀錄。",
                      fields: [
                        {
                          name: "status",
                          label: "狀態",
                          value: i.status,
                          required: true,
                          options: [
                            "invited",
                            "scheduled",
                            "completed",
                            "cancelled",
                          ].map((value) => ({ value, label: statuses[value] })),
                        },
                        {
                          name: "startsAt",
                          label: "新的面試時間",
                          type: "datetime-local",
                          value: i.starts_at
                            ? new Date(
                                new Date(i.starts_at).getTime() -
                                  new Date(i.starts_at).getTimezoneOffset() *
                                    60000,
                              )
                                .toISOString()
                                .slice(0, 16)
                            : "",
                        },
                        {
                          name: "notes",
                          label: "備註",
                          type: "textarea",
                          value: i.notes,
                        },
                      ],
                      submit: "保存更新",
                      action: (v) =>
                        run(() =>
                          api("/interviews/" + i.id + "/update", "POST", {
                            ...v,
                            startsAt: v.startsAt
                              ? new Date(v.startsAt).toISOString()
                              : null,
                          }),
                        ),
                    })
                  }
                >
                  改期或更新
                </button>
              </article>
            ))}
          </div>
        ) : (
          <section className="card">
            <Empty
              title="為每一次對話做好準備"
              body="只有正式邀請才記為面試。日常練習可以放在「面試準備」。"
            />
          </section>
        )
      ) : tab === "notes" ? (
        d.notes?.length ? (
          <div className="job-grid">
            {d.notes.map((n: Row) => (
              <article className="card" key={n.id}>
                <Badge value="只有本人可見" />
                <h2>{n.title}</h2>
                <p className="preserve">{n.content}</p>
                <small>{date(n.created_at)}</small>
                {n.asset_id && (
                  <p>
                    <a href={base + "/api/assets/" + n.asset_id}>
                      下載原始附件
                    </a>
                  </p>
                )}
              </article>
            ))}
          </div>
        ) : (
          <section className="card">
            <Empty
              title="面試結束，把收穫留下來"
              body="題目、你的回答、收到的回饋，都能變成下一次面試的準備。"
            />
          </section>
        )
      ) : (
        <section className="card">
          {d.preparations?.length ? (
            d.preparations.map((p: Row) => (
              <article className="prep-item" key={p.id}>
                <Badge value="練習 · 不計入正式面試" />
                <h2>{p.title}</h2>
                <p className="preserve">{p.notes}</p>
              </article>
            ))
          ) : (
            <Empty
              title="練習，也是一種進展"
              body="為目標公司或職位建立準備筆記，可以在 Claude 對話中透過 MCP 保存。"
            />
          )}
        </section>
      )}
    </>
  );
}
function Offers() {
  const { data: d, form, run } = useApp();
  const add = async () => {
    const apps = await api("/applications");
    form({
      title: "記錄收到的 Offer",
      intro: "只記錄已明確收到的條件；薪資討論不等於正式 offer。",
      fields: [
        {
          name: "applicationId",
          label: "對應申請",
          required: true,
          options: options(apps.items, (a) => a.company + " · " + a.title),
        },
        {
          name: "currency",
          label: "幣別",
          required: true,
          options: ["TWD", "USD", "EUR", "GBP", "JPY", "CAD", "AUD"].map(
            (value) => ({ value, label: value }),
          ),
        },
        { name: "amount", label: "底薪（可留白）", type: "number" },
        {
          name: "period",
          label: "薪資期間",
          required: true,
          options: [
            { value: "month", label: "月薪" },
            { value: "year", label: "年薪" },
            { value: "hour", label: "時薪" },
          ],
        },
        { name: "deadline", label: "回覆期限", type: "date" },
        { name: "terms", label: "條件、文件來源與備註", type: "textarea" },
      ],
      submit: "確認收到 Offer",
      action: (v) =>
        run(() =>
          api("/offers", "POST", {
            ...v,
            amount: v.amount === "" ? null : Number(v.amount),
            deadline: v.deadline || null,
          }),
        ),
    });
  };
  return (
    <>
      <div className="action-bar">
        <p className="muted">保留每個選擇的原始條件，按自己的節奏做決定。</p>
        <button onClick={add}>＋ 記錄 Offer</button>
      </div>
      {d.items?.length ? (
        <div className="job-grid">
          {d.items.map((o: Row) => (
            <article className="card offer-card" key={o.id}>
              <div className="section-head">
                <span className="eyebrow">A NEW POSSIBILITY</span>
                <Badge value={o.status} />
              </div>
              <h2>{o.company}</h2>
              <p>{o.title}</p>
              <div className="offer-salary">
                {o.amount !== null
                  ? `${o.currency} ${Number(o.amount).toLocaleString()}`
                  : "薪資尚未記錄"}
                <small>
                  {" "}
                  /{" "}
                  {o.period === "month"
                    ? "月"
                    : o.period === "year"
                      ? "年"
                      : "小時"}
                </small>
              </div>
              <p className="preserve">{o.terms}</p>
              <p className="muted">
                回覆期限：{o.deadline ? date(o.deadline) : "未指定"}
              </p>
              {o.status === "received" && (
                <div className="actions">
                  <button
                    className="secondary"
                    onClick={() =>
                      form({
                        title: "更新 Offer 條件",
                        intro:
                          "舊條件會保存為歷史版本；只更新已明確收到的內容。",
                        fields: [
                          {
                            name: "currency",
                            label: "幣別",
                            required: true,
                            value: o.currency,
                            options: [
                              "TWD",
                              "USD",
                              "EUR",
                              "GBP",
                              "JPY",
                              "CAD",
                              "AUD",
                            ].map((value) => ({ value, label: value })),
                          },
                          {
                            name: "amount",
                            label: "底薪",
                            type: "number",
                            value: o.amount ?? "",
                          },
                          {
                            name: "period",
                            label: "薪資期間",
                            value: o.period,
                            required: true,
                            options: [
                              { value: "month", label: "月薪" },
                              { value: "year", label: "年薪" },
                              { value: "hour", label: "時薪" },
                            ],
                          },
                          {
                            name: "deadline",
                            label: "回覆期限",
                            type: "date",
                            value: o.deadline?.slice(0, 10) ?? "",
                          },
                          {
                            name: "terms",
                            label: "條件與備註",
                            type: "textarea",
                            value: o.terms,
                          },
                        ],
                        submit: "保存新版條件",
                        action: (v) =>
                          run(() =>
                            api("/offers/" + o.id + "/revise", "POST", {
                              ...v,
                              amount: v.amount === "" ? null : Number(v.amount),
                              deadline: v.deadline || null,
                              expectedRevision: o.revision,
                            }),
                          ),
                      })
                    }
                  >
                    更新條件
                  </button>
                  {[
                    ["accepted", "記錄接受"],
                    ["declined", "記錄婉拒"],
                  ].map(([decision, label]) => (
                    <button
                      key={decision}
                      className={decision === "declined" ? "secondary" : ""}
                      onClick={() =>
                        form({
                          title: label + "這份 Offer",
                          intro: "只更新你的紀錄，不會替你寄信或回覆公司。",
                          fields: [],
                          submit: "確認" + label,
                          action: () =>
                            run(() =>
                              api("/offers/" + o.id + "/decision", "POST", {
                                decision,
                                expectedRevision: o.revision,
                              }),
                            ),
                        })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <section className="card">
          <Empty
            title="為新的開始，留一個位置"
            body="收到 offer 後，將條件、期限與你的決定記錄在這裡。"
          />
        </section>
      )}
    </>
  );
}
function Collections() {
  const { data: d, form, run, go } = useApp();
  return (
    <>
      <div className="action-bar">
        <p className="muted">
          按職類、方向或地點分組，清楚知道自己還有哪些機會。
        </p>
        <button
          onClick={() =>
            form({
              title: "建立職缺分組",
              fields: [
                {
                  name: "name",
                  label: "分組名稱",
                  required: true,
                  placeholder: "例如：台北 · 產品經理",
                },
              ],
              submit: "建立分組",
              action: (v) => run(() => api("/collections", "POST", v)),
            })
          }
        >
          ＋ 新增分組
        </button>
      </div>
      {d.items?.length ? (
        <div className="job-grid">
          {d.items.map((c: Row) => (
            <article className="card" key={c.id}>
              <p className="eyebrow">MY COLLECTION</p>
              <h2>{c.name}</h2>
              <p className="muted">
                {c.jobs.filter((j: Row) => !j.submitted_at).length}{" "}
                個尚未確認送出 · 共 {c.jobs.length} 個職缺
              </p>
              {c.jobs.map((j: Row) => (
                <div className="list-row" key={j.id}>
                  <div className="grow">
                    <strong>{j.title}</strong>
                    <small>{j.company}</small>
                  </div>
                  <Badge value={j.status ?? "尚未申請"} />
                </div>
              ))}
              <button className="link" onClick={() => go("jobs")}>
                從職缺頁加入更多 →
              </button>
            </article>
          ))}
        </div>
      ) : (
        <section className="card">
          <Empty
            title="把相似的機會放在一起"
            body="建立分組後，可從職缺頁加入想追蹤的工作。別人投過，不會影響你的未投清單。"
          />
        </section>
      )}
    </>
  );
}
function Groups() {
  const { data: d, form, run, notify, user } = useApp();
  const [detail, setDetail] = useState<Row | null>(null),
    [gid, setGid] = useState("");
  const load = async (id: string) => {
    setGid(id);
    setDetail(await api("/groups/" + id));
  };
  const action = async (fn: () => Promise<any>) => {
    await run(fn);
    if (gid) await load(gid);
  };
  const join = () =>
    form({
      title: "加入求職小組",
      fields: [{ name: "token", label: "邀請碼", required: true }],
      submit: "加入",
      action: (v) => run(() => api("/groups/join", "POST", v)),
    });
  return (
    <>
      <div className="action-bar">
        <p className="muted">一起找機會，各自掌握自己的求職進度。</p>
        <div className="actions">
          <button className="secondary" onClick={join}>
            輸入邀請碼
          </button>
          <button
            onClick={() =>
              form({
                title: "建立求職小組",
                fields: [{ name: "name", label: "小組名稱", required: true }],
                submit: "建立小組",
                action: (v) => run(() => api("/groups", "POST", v)),
              })
            }
          >
            ＋ 建立小組
          </button>
        </div>
      </div>
      <div className="group-pills">
        {d.items?.map((g: Row) => (
          <button
            className={g.id === gid ? "active" : "secondary"}
            key={g.id}
            onClick={() => load(g.id)}
          >
            {g.name} <small>{g.member_count} 人</small>
          </button>
        ))}
      </div>
      {detail ? (
        <>
          <div className="card group-header">
            <div>
              <p className="eyebrow">PRIVATE CAREER CIRCLE</p>
              <h2>{detail.group.name}</h2>
              <p>{detail.members.map((m: Row) => m.name).join(" · ")}</p>
            </div>
            <div className="stack">
              <button
                className="secondary"
                onClick={() =>
                  action(() =>
                    api("/groups/" + gid + "/sharing", "POST", {
                      shareStatus: !detail.membership.share_status,
                    }),
                  )
                }
              >
                {detail.membership.share_status
                  ? "關閉我的進度分享"
                  : "分享我的申請進度"}
              </button>
              {["owner", "admin"].includes(detail.membership.role) && (
                <button
                  onClick={async () => {
                    const r = await api(
                      "/groups/" + gid + "/invites",
                      "POST",
                      {},
                    );
                    form({
                      title: "邀請朋友加入",
                      intro:
                        "此邀請 7 天內有效，限使用一次。朋友需要先有 CareerOS 帳號。",
                      fields: [
                        { name: "invite", label: "邀請碼", value: r.invite },
                        { name: "url", label: "邀請連結", value: r.url },
                      ],
                      submit: "完成",
                      action: async () => {},
                    });
                  }}
                >
                  邀請朋友
                </button>
              )}
            </div>
          </div>
          <div className="actions">
            {detail.membership.role === "owner" ? (
              <>
                <button
                  className="secondary"
                  onClick={() =>
                    form({
                      title: "管理小組成員",
                      fields: [
                        {
                          name: "userId",
                          label: "成員",
                          required: true,
                          options: options(
                            detail.members
                              .filter((m: Row) => m.user_id !== user.id)
                              .map((m: Row) => ({ ...m, id: m.user_id })),
                            (m) => m.name,
                          ),
                        },
                        {
                          name: "action",
                          label: "操作",
                          required: true,
                          options: [
                            { value: "remove-member", label: "移除成員" },
                            { value: "transfer", label: "移轉小組擁有者" },
                          ],
                        },
                      ],
                      submit: "確認更新",
                      action: (v) =>
                        action(() =>
                          api("/groups/" + gid + "/" + v.action, "POST", {
                            userId: v.userId,
                          }),
                        ),
                    })
                  }
                >
                  管理成員／移轉
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    action(() =>
                      api("/groups/" + gid + "/revoke-invites", "POST", {}),
                    )
                  }
                >
                  撤銷未使用邀請
                </button>
                <button
                  className="link danger"
                  onClick={() =>
                    form({
                      title: "刪除這個小組",
                      intro: "刪除小組共享內容與討論，成員自己的資料仍會保留。",
                      fields: [],
                      submit: "確認刪除小組",
                      action: async () => {
                        await run(() => api("/groups/" + gid, "DELETE"));
                        setDetail(null);
                        setGid("");
                      },
                    })
                  }
                >
                  刪除小組
                </button>
              </>
            ) : (
              <button
                className="link"
                onClick={() =>
                  form({
                    title: "離開小組",
                    intro: "離開後會撤回你的共享面經。",
                    fields: [],
                    submit: "確認離開",
                    action: async () => {
                      await run(() =>
                        api("/groups/" + gid + "/remove-member", "POST", {
                          userId: user.id,
                        }),
                      );
                      setDetail(null);
                      setGid("");
                    },
                  })
                }
              >
                離開小組
              </button>
            )}
          </div>
          <Notice>
            履歷、完整經驗、信箱與 offer
            金額不會分享。未分享的成員進度代表未知。面經只會分享你選定的文字快照。
          </Notice>
          <div className="columns">
            <section className="card">
              <div className="section-head">
                <h2>共用職缺池</h2>
                <button
                  className="secondary"
                  onClick={async () => {
                    const j = await api("/jobs");
                    form({
                      title: "分享一個職缺",
                      fields: [
                        {
                          name: "jobId",
                          label: "我的已保存職缺",
                          required: true,
                          options: options(
                            j.items,
                            (j) => j.company + " · " + j.title,
                          ),
                        },
                      ],
                      submit: "分享職缺內容",
                      action: (v) =>
                        action(() =>
                          api("/groups/" + gid + "/jobs", "POST", v),
                        ),
                    });
                  }}
                >
                  ＋ 分享職缺
                </button>
              </div>
              {detail.jobs.length ? (
                detail.jobs.map((j: Row) => (
                  <div className="shared-job" key={j.id}>
                    <h3>{j.snapshot.title}</h3>
                    <p>
                      {j.snapshot.company} · {j.snapshot.location}
                    </p>
                    <Badge value={j.my_status ?? "我尚未申請"} />
                    {j.shared_statuses?.map((s: Row, i: number) => (
                      <small key={i}>
                        　{s.name}：{statuses[s.status] ?? s.status}
                      </small>
                    ))}
                    <p>
                      <button
                        className="link"
                        onClick={() =>
                          action(() =>
                            api("/groups/" + gid + "/save-job", "POST", {
                              jobId: j.id,
                            }),
                          )
                        }
                      >
                        保存到我的職缺池 →
                      </button>
                    </p>
                  </div>
                ))
              ) : (
                <p className="muted spacious">
                  把同類型職缺放在一起，保留每個人的獨立申請狀態。
                </p>
              )}
              <div className="section-head">
                <h2>共享面經</h2>
                <button
                  className="secondary"
                  onClick={async () => {
                    const n = await api("/interviews");
                    form({
                      title: "分享一篇面經文字快照",
                      intro:
                        "原始附件與錄音保持私人。請確認內容適合分享給目前小組成員。",
                      fields: [
                        {
                          name: "noteId",
                          label: "我的面經",
                          required: true,
                          options: options(n.notes, (n) => n.title),
                        },
                      ],
                      submit: "確認分享",
                      action: (v) =>
                        action(() =>
                          api("/groups/" + gid + "/notes", "POST", v),
                        ),
                    });
                  }}
                >
                  分享面經
                </button>
              </div>
              {detail.notes.map((n: Row) => (
                <article className="prep-item" key={n.id}>
                  <small>{n.author}</small>
                  <h3>{n.snapshot.title}</h3>
                  <p className="preserve">{n.snapshot.content}</p>
                  {n.owner_id === user.id && (
                    <button
                      className="link"
                      onClick={() =>
                        action(() => api("/note-shares/" + n.id, "DELETE"))
                      }
                    >
                      撤銷我的分享
                    </button>
                  )}
                </article>
              ))}
            </section>
            <aside className="card">
              <div className="section-head">
                <h2>小組討論</h2>
                <button
                  className="link"
                  onClick={() =>
                    form({
                      title: "新增討論",
                      fields: [
                        {
                          name: "body",
                          label: "內容",
                          type: "textarea",
                          required: true,
                        },
                      ],
                      submit: "發佈到小組",
                      action: (v) =>
                        action(() =>
                          api("/groups/" + gid + "/comments", "POST", v),
                        ),
                    })
                  }
                >
                  ＋
                </button>
              </div>
              {detail.comments.map((c: Row) => (
                <div className="comment" key={c.id}>
                  <strong>{c.author ?? "已離開成員"}</strong>
                  <p className="preserve">{c.body}</p>
                  <small>{date(c.created_at)}</small>
                </div>
              ))}
            </aside>
          </div>
        </>
      ) : (
        <section className="card">
          <Empty
            title="找工作的路上，可以有人同行"
            body="選擇一個小組，分享職缺、討論準備方法；私人資料由你掌握。"
          />
        </section>
      )}
    </>
  );
}
function Career() {
  const { data: d, form, run, go } = useApp();
  return (
    <>
      <div className="welcome">
        <div>
          <p className="eyebrow">BUILD YOUR NEXT CHAPTER</p>
          <h2>下一步不必猜，從證據開始。</h2>
          <p>對照已確認的經驗與你保存的職缺，找出值得探索的方向。</p>
        </div>
        <button
          onClick={() =>
            form({
              title: "建立職涯分析",
              intro:
                "建議根據你的經驗與最多 20 份近期已保存職缺。樣本不代表整體市場，也不保證錄取。",
              fields: [
                { name: "goal", label: "想探索的方向", required: true },
                {
                  name: "constraints",
                  label: "地點、時間、預算與其他限制",
                  type: "textarea",
                },
              ],
              submit: "開始分析",
              action: (v) =>
                run(
                  () =>
                    api("/tasks", "POST", {
                      kind: "career_analysis",
                      input: v,
                    }),
                  "職涯分析任務已建立",
                ),
            })
          }
        >
          探索我的下一步 →
        </button>
      </div>
      {d.items?.length ? (
        d.items.map((p: Row) => (
          <section key={p.id}>
            <div className="section-head">
              <h2>{p.title}</h2>
              <small>
                經驗版本 {p.career_revision} · {p.sample.length} 份職缺樣本 ·{" "}
                {date(p.created_at)}
              </small>
            </div>
            <div className="job-grid">
              {p.content.directions.map((x: Row, i: number) => (
                <article className="card" key={i}>
                  <span className="direction-number">0{i + 1}</span>
                  <h2>{x.title}</h2>
                  <p>{x.reason}</p>
                  <hr />
                  <h3>能力與證據</h3>
                  {x.gaps.map((g: Row, k: number) => (
                    <div className="gap" key={k}>
                      <strong>{g.skill}</strong>
                      <Badge
                        value={
                          (
                            {
                              unknown: "資料不足，待確認",
                              evidence_needed: "需要補充證據",
                              confirmed_gap: "本人已確認缺口",
                            } as Record<string, string>
                          )[g.state] ?? g.state
                        }
                      />
                      <p>{g.reason}</p>
                    </div>
                  ))}
                  <small>
                    依據 {x.evidenceJobIds.length}{" "}
                    份目標職缺；證照資格需向發證機關核對。
                  </small>
                </article>
              ))}
            </div>
          </section>
        ))
      ) : (
        <section className="card">
          <Empty
            title="先看清楚自己與目標之間的距離"
            body="累積已確認經驗與目標職缺後，Agent 會比較方向、指出待補證據，並提出可驗收的成長任務。"
          >
            <div className="actions">
              <button onClick={() => go("experience")}>补充經驗</button>
              <button className="secondary" onClick={() => go("jobs")}>
                收集目標職缺
              </button>
            </div>
          </Empty>
        </section>
      )}
      <section className="card">
        <h2>把建議變成可看見的成果</h2>
        {d.tasks?.length ? (
          d.tasks.map((t: Row) => (
            <div className="growth-row" key={t.id}>
              <div className="grow">
                <h3>{t.title}</h3>
                <p>{t.output}</p>
                {t.completed_at && <small>成果：{t.evidence}</small>}
              </div>
              {t.completed_at ? (
                <Badge value="已完成" />
              ) : (
                <button
                  className="secondary"
                  onClick={() =>
                    form({
                      title: "記錄任務成果",
                      intro:
                        "完成練習不會自動變成任職經驗。確認後可回經驗庫新增真實成果。",
                      fields: [
                        {
                          name: "evidence",
                          label: "可核對的成果、連結或說明",
                          type: "textarea",
                          required: true,
                        },
                      ],
                      submit: "記錄完成",
                      action: (v) =>
                        run(() =>
                          api("/growth-tasks/" + t.id + "/complete", "POST", v),
                        ),
                    })
                  }
                >
                  記錄成果
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="muted">分析完成後，這裡會列出具體的下一步。</p>
        )}
      </section>
    </>
  );
}
function Tasks() {
  const { data: d, run, go, form } = useApp();
  return (
    <>
      <Notice>
        純 MCP 模式需要你在已連接 CareerOS 的 Claude 說：「請處理我的 CareerOS
        待辦生成任務」。網站不能自行喚醒你的 Claude。BYOK 模式則由背景工作執行。
      </Notice>
      {d.proposals?.length > 0 && (
        <section className="card">
          <h2>Agent 提議，等你確認</h2>
          <p className="muted">先核對真實事件；練習面試不代表收到邀請。</p>
          {d.proposals.map((p: Row) => (
            <article className="fact-card" key={p.id}>
              <strong>
                {p.payload.type === "submitted"
                  ? "已投遞"
                  : p.payload.type === "interview_invited"
                    ? "面試邀請"
                    : p.payload.type}
              </strong>
              <p className="preserve">{p.payload.notes}</p>
              <small>
                申請 {p.payload.applicationId} · {date(p.payload.occurredAt)}
              </small>
              <div className="actions">
                <button
                  onClick={() =>
                    form({
                      title: "確認這項真實進展",
                      intro:
                        "此操作會更新申請紀錄。請核對申請、時間與事件是否正確。",
                      fields: [],
                      submit: "確認並更新",
                      action: () =>
                        run(() =>
                          api("/proposals/" + p.id + "/confirm", "POST", {}),
                        ),
                    })
                  }
                >
                  核對後確認
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    run(() =>
                      api("/proposals/" + p.id + "/dismiss", "POST", {}),
                    )
                  }
                >
                  忽略
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
      {d.signals?.length > 0 && (
        <section className="card">
          <h2>信箱與日曆訊號</h2>
          {d.signals.map((s: Row) => (
            <article className="fact-card" key={s.id}>
              <strong>{s.payload.subject ?? s.payload.title}</strong>
              <p>{s.payload.from}</p>
              <p>{s.payload.snippet ?? s.payload.note}</p>
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() => go("applications")}
                >
                  到投遞中心核對並記錄
                </button>
                <button
                  className="link"
                  onClick={() =>
                    run(() => api("/signals/" + s.id + "/dismiss", "POST", {}))
                  }
                >
                  已處理／忽略
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
      <section className="card">
        <div className="section-head">
          <h2>持久任務紀錄</h2>
          <button className="secondary" onClick={() => go("settings")}>
            管理 AI 連接
          </button>
        </div>
        {d.items?.length ? (
          d.items.map((t: Row) => (
            <div className="task-row" key={t.id}>
              <div className="task-symbol">
                {t.status === "succeeded"
                  ? "✓"
                  : t.status === "running"
                    ? "◌"
                    : "·"}
              </div>
              <div className="grow">
                <strong>{kinds[t.kind] ?? t.kind}</strong>
                <p>
                  {date(t.created_at)} · <code>{t.id.slice(0, 8)}</code>
                </p>
                {t.result && (
                  <p className="muted">
                    {t.result.saved !== undefined
                      ? `保存 ${t.result.saved} 個職缺`
                      : t.result.needsConfirmation
                        ? "草稿已保存，請到對應頁面確認內容"
                        : t.result.characters !== undefined
                          ? `已處理 ${t.result.characters} 個字元`
                          : (t.result.scope ?? "結果已保存到工作台")}
                  </p>
                )}
                {t.error && <p className="error-text">{t.error}</p>}
              </div>
              <Badge value={t.status} />
              {["queued", "waiting_client", "failed"].includes(t.status) && (
                <button
                  className="link"
                  onClick={() =>
                    run(
                      () => api("/tasks/" + t.id + "/cancel", "POST", {}),
                      "任務已取消",
                    )
                  }
                >
                  取消
                </button>
              )}
            </div>
          ))
        ) : (
          <Empty
            title="你的 Agent 待命中"
            body="整理經驗、生成履歷、搜尋職缺與分析職涯的工作，都會保存真實進度。"
          />
        )}
      </section>
    </>
  );
}
function GoogleAccount() {
  const { user, form } = useApp();
  const [status, setStatus] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState(false);
  const [password, setPassword] = useState("");
  useEffect(() => {
    let alive = true;
    api("/auth/google/status")
      .then((r) => {
        if (alive) setStatus(r);
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [user.id]);
  return (
    <section className="card">
      <h2>Google 登入</h2>
      {error && <div className="error">{error}</div>}
      {!status ? (
        <p className="muted">正在讀取登入設定…</p>
      ) : (
        <>
          <p className="muted">
            只用於登入你的工作台，信箱與日曆需要另行連接。
          </p>
          {status.linked ? (
            <p>
              已綁定：<strong>{status.email}</strong>
            </p>
          ) : (
            <p>尚未綁定 Google 帳號。</p>
          )}
          {!status.enabled ? (
            <Badge value="待管理員啟用 Google 登入" />
          ) : (
            <>
              {!status.linked && (
                <label className="field">
                  <span>目前 CareerOS 密碼</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              )}
              {!active && (
                <button
                  className="secondary"
                  disabled={!status.linked && !password}
                  onClick={() => setActive(true)}
                >
                  {status.linked
                    ? "重新驗證 Google"
                    : "下一步：綁定 Google 帳號"}
                </button>
              )}
              {active && (
                <GoogleLogin
                  clientId={status.clientId}
                  intent={status.linked ? "reauth" : "link"}
                  password={() => password}
                  onSuccess={() => {
                    setPassword("");
                    location.reload();
                  }}
                />
              )}
              {status.linked && (
                <p className="muted">
                  <small>
                    {status.recentlyVerified
                      ? "已完成 Google 驗證，可於五分鐘內執行帳戶操作。"
                      : "只有 Google 登入的帳號，設定密碼或刪除資料前需重新驗證。"}
                  </small>
                </p>
              )}
            </>
          )}
          {status.linked && status.hasPassword && (
            <p>
              <button
                className="link danger"
                onClick={() =>
                  form({
                    title: "解除 Google 登入綁定",
                    intro:
                      "解除後請改用密碼登入；所有裝置會登出並撤銷 MCP 授權。信箱與日曆連接另行管理。",
                    fields: [
                      {
                        name: "currentPassword",
                        label: "目前密碼",
                        type: "password",
                        required: true,
                      },
                    ],
                    submit: "解除並登出",
                    action: async (v) => {
                      await api("/auth/google/unlink", "POST", v);
                      location.reload();
                    },
                  })
                }
              >
                解除 Google 登入
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
function Settings() {
  const { data: d, user, run, form, notify } = useApp();
  const settings = d.settings ?? user.settings;
  return (
    <>
      <div className="columns">
        <section className="card">
          <p className="eyebrow">BRING YOUR OWN AI</p>
          <h2>連接自己的 Claude</h2>
          <p className="muted">
            在 Claude 的 Connectors
            新增自訂連接，填入下方網址。透過登入與授權連接你的 CareerOS 帳戶。
          </p>
          <label className="field">
            <span>Remote MCP 網址</span>
            <input readOnly value={d.mcpUrl ?? ""} />
          </label>
          <button
            className="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(d.mcpUrl);
              notify("MCP 網址已複製");
            }}
          >
            複製網址
          </button>
          <hr />
          <h3>AI 執行模式</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = Object.fromEntries(new FormData(e.currentTarget));
              void run(
                () =>
                  api("/settings", "POST", {
                    ...v,
                    dailyTokenLimit: Number(v.dailyTokenLimit),
                  }),
                "偏好已保存",
              );
            }}
          >
            <label className="field">
              <span>推理來源</span>
              <select
                name="mode"
                defaultValue={settings.mode}
                key={settings.mode}
              >
                <option value="mcp">我的 Claude · MCP</option>
                <option value="byok">背景執行 · 我的 Anthropic API key</option>
                <option value="manual">手動整理</option>
              </select>
            </label>
            <label className="field">
              <span>時區</span>
              <input name="timezone" defaultValue={settings.timezone} />
            </label>
            <label className="field">
              <span>每日 token 預算上限</span>
              <input
                name="dailyTokenLimit"
                type="number"
                min="1000"
                max="1000000"
                defaultValue={settings.dailyTokenLimit}
              />
            </label>
            <small>
              預算包含待結算預留量；沒有 API key 時不會改用平台付費。
            </small>
            <p>
              <button>保存偏好</button>
            </p>
          </form>
          <h3>已授權 AI 連接</h3>
          {d.grants?.length ? (
            d.grants.map((g: Row) => (
              <div className="list-row" key={g.grant_id}>
                <span className="grow">{g.name ?? "MCP client"}</span>
                <button
                  className="link danger"
                  onClick={() =>
                    run(() =>
                      api("/grants/" + g.grant_id + "/revoke", "POST", {}),
                    )
                  }
                >
                  撤銷
                </button>
              </div>
            ))
          ) : (
            <p className="muted">尚未連接外部 AI。</p>
          )}
        </section>
        <div className="stack">
          <section className="card">
            <h2>API keys</h2>
            <p className="muted">
              Claude 訂閱與 API 計費分開。Key 加密保存，僅在你的任務執行時使用。
            </p>
            {["anthropic", "openai"].map((provider) => (
              <div className="credential" key={provider}>
                <div>
                  <strong>
                    {provider === "anthropic"
                      ? "Anthropic · 文字生成"
                      : "OpenAI · 音檔轉錄"}
                  </strong>
                  <p>
                    {d.credentials?.find((c: Row) => c.provider === provider)
                      ? "已設定 · ····" +
                        d.credentials.find((c: Row) => c.provider === provider)
                          .last4
                      : "尚未設定"}
                  </p>
                </div>
                <button
                  className="secondary"
                  onClick={() =>
                    form({
                      title: "設定 " + provider + " API key",
                      intro:
                        "不會在儲存後顯示完整 key。請使用具有個別用量限制的 key。",
                      fields: [
                        {
                          name: "key",
                          label: "API key",
                          type: "password",
                          required: true,
                        },
                      ],
                      submit: "加密保存",
                      action: (v) =>
                        run(
                          () =>
                            api("/credentials", "POST", {
                              provider,
                              key: v.key,
                            }),
                          "Key 已保存",
                        ),
                    })
                  }
                >
                  設定
                </button>
                {d.credentials?.some((c: Row) => c.provider === provider) && (
                  <button
                    className="link danger"
                    onClick={() =>
                      run(() => api("/credentials/" + provider, "DELETE"))
                    }
                  >
                    移除
                  </button>
                )}
              </div>
            ))}
          </section>
          <section className="card">
            <h2>信箱與日曆</h2>
            <p className="muted">
              唯讀取得求職相關通知，先列為訊號供你確認，不會替你回信或接受
              offer。
            </p>
            {d.capabilities?.google ? (
              <div className="actions">
                <button
                  onClick={async () => {
                    const r = await run(() =>
                      api("/connections/google/start", "POST", {}),
                    );
                    location.assign(r.url);
                  }}
                >
                  連接 Google
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    run(
                      () =>
                        api("/tasks", "POST", {
                          kind: "sync_google",
                          input: {},
                        }),
                      "同步任務已建立",
                    )
                  }
                >
                  同步通知
                </button>
                <button
                  className="link danger"
                  onClick={() =>
                    run(() => api("/connections/google", "DELETE"))
                  }
                >
                  斷開
                </button>
              </div>
            ) : (
              <Badge value="待管理員設定 Google OAuth" />
            )}
            <p>
              <small>尚未連接時，可在投遞中心手動記錄邀請與結果。</small>
            </p>
          </section>
          <section className="card">
            <h2>近期使用量</h2>
            {d.usage?.length ? (
              d.usage.map((u: Row) => (
                <div className="list-row" key={u.day}>
                  <span className="grow">{date(u.day)}</span>
                  <strong>{u.tokens.toLocaleString()} tokens</strong>
                  <small>{u.requests} 次任務</small>
                </div>
              ))
            ) : (
              <p className="muted">目前沒有 API 使用紀錄。</p>
            )}
          </section>
          <GoogleAccount />
          <section className="card">
            <h2>帳戶與資料</h2>
            <p className="muted">
              匯出包含經驗版本、履歷、申請與面經。附件可透過匯出檔中的私人連結另行下載。
            </p>
            <div className="stack">
              <a
                className="button secondary"
                href={base + "/api/account/export"}
              >
                匯出個人資料 JSON
              </a>
              <button
                className="secondary"
                onClick={() =>
                  form({
                    title:
                      user.hasPassword === false ? "設定登入密碼" : "更換密碼",
                    intro:
                      "完成後將登出所有裝置並撤銷 MCP 授權。只有 Google 登入的帳號請先在上方重新驗證。",
                    fields: [
                      ...(user.hasPassword === false
                        ? []
                        : [
                            {
                              name: "currentPassword",
                              label: "目前密碼",
                              type: "password",
                              required: true,
                            },
                          ]),
                      {
                        name: "newPassword",
                        label: "新密碼（至少 12 字元）",
                        type: "password",
                        required: true,
                      },
                    ],
                    submit: "更換並重新登入",
                    action: async (v) => {
                      await api("/account/password", "POST", v);
                      location.reload();
                    },
                  })
                }
              >
                {user.hasPassword === false ? "設定登入密碼" : "更換密碼"}
              </button>
              {user.role !== "owner" && (
                <button
                  className="link danger"
                  onClick={() =>
                    form({
                      title: "刪除帳戶與私人資料",
                      intro:
                        "此操作無法復原。請先匯出資料，並移轉或刪除你擁有的小組。線上資料會刪除；加密本機備份最多保留 7 天，還原需套用刪除紀錄。只有 Google 登入的帳號請先在上方重新驗證。",
                      fields: [
                        ...(user.hasPassword === false
                          ? []
                          : [
                              {
                                name: "password",
                                label: "目前密碼",
                                type: "password",
                                required: true,
                              },
                            ]),
                        {
                          name: "confirmation",
                          label: "輸入 DELETE 確認",
                          required: true,
                        },
                      ],
                      submit: "永久刪除",
                      action: async (v) => {
                        await api("/account/delete", "POST", v);
                        location.reload();
                      },
                    })
                  }
                >
                  刪除我的帳戶
                </button>
              )}
            </div>
          </section>
          {user.role === "owner" && (
            <section className="card">
              <h2>工作台管理</h2>
              <p className="muted">
                註冊採邀請制。小組邀請與工作台帳戶邀請是分開的。
              </p>
              <button
                className="secondary"
                onClick={async () => {
                  const r = await api("/auth/invites", "POST", {});
                  form({
                    title: "工作台邀請碼",
                    intro: "7 天內有效，只能建立一個帳戶。",
                    fields: [
                      { name: "invite", label: "邀請碼", value: r.token },
                    ],
                    submit: "完成",
                    action: async () => {},
                  });
                }}
              >
                建立帳戶邀請碼
              </button>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
function Consent({ request, onDone }: { request: string; onDone: () => void }) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    api("/oauth/consent/" + encodeURIComponent(request))
      .then(setData)
      .catch((e) => setError(message(e)));
  }, [request]);
  return (
    <section className="card consent">
      <p className="eyebrow">CONNECT YOUR WORKSPACE</p>
      <h2>允許 {data?.name ?? "AI"} 連接 CareerOS？</h2>
      <p>你即將把所選權限授予這個 AI 客戶端。可以隨時在偏好與連接撤銷。</p>
      {data && (
        <>
          <p>
            回傳網站：<strong>{new URL(data.redirectUri).hostname}</strong>
          </p>
          <ul>
            {data.scopes.map((s: string) => (
              <li key={s}>
                {s === "careeros:read"
                  ? "讀取你的私人經驗、履歷、職缺與申請資料"
                  : "保存草稿、職缺、練習與待確認的更新；不能自行確認投遞或接受 offer"}
              </li>
            ))}
          </ul>
          <div className="actions">
            {[true, false].map((approve) => (
              <button
                key={String(approve)}
                className={approve ? "" : "secondary"}
                onClick={async () => {
                  try {
                    const r = await api(
                      "/oauth/consent/" + encodeURIComponent(request),
                      "POST",
                      { approve },
                    );
                    location.assign(r.redirect);
                  } catch (e) {
                    setError(message(e));
                  }
                }}
              >
                {approve ? "允許連接" : "取消"}
              </button>
            ))}
          </div>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}
const endpoints: Record<string, string> = {
  dashboard: "/dashboard",
  experience: "/career",
  resumes: "/resumes",
  jobs: "/jobs",
  collections: "/collections",
  groups: "/groups",
  applications: "/applications",
  interviews: "/interviews",
  offers: "/offers",
  tasks: "/tasks",
  career: "/career-plans",
  settings: "/settings",
};
function App() {
  const [user, updateUser] = useState<Row | null>(null),
    [authLoading, setAuthLoading] = useState(true),
    [route, setRoute] = useState("dashboard"),
    [data, setData] = useState<Row>({}),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [modal, setModal] = useState<Modal | null>(null),
    [refresh, setRefresh] = useState(0),
    [mobile, setMobile] = useState(false),
    [consent, setConsent] = useState("");
  const sessionGeneration = useRef(0);
  const generation = sessionGeneration.current;
  const sessionCurrent = () => generation === sessionGeneration.current;
  const setUser = (next: Row | null) => {
    sessionGeneration.current += 1;
    setModal(null);
    setToast("");
    updateUser(next);
  };
  // Async requests retain the initiating render's generation across logout/login.
  const form = (next: Modal) => {
    if (sessionCurrent())
      setModal({
        ...next,
        action: (values) => {
          if (!sessionCurrent())
            return Promise.reject(new ApiError("LOGIN_REQUIRED"));
          return next.action(values);
        },
      });
  };
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRoute = useRef("");
  const notify = (s: string) => {
    setToast(s);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6000);
  };
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      if (event.reason instanceof ApiError) {
        event.preventDefault();
        notify(message(event.reason));
      }
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);
  const go = (r: string) => {
    location.hash = r;
    setMobile(false);
  };
  const reload = () => setRefresh((x) => x + 1);
  const run = async (fn: () => Promise<any>, success = "已保存") => {
    try {
      if (!sessionCurrent()) throw new ApiError("LOGIN_REQUIRED");
      const r = await fn();
      if (sessionCurrent()) {
        reload();
        notify(success);
      }
      return r;
    } catch (e) {
      if (sessionCurrent()) notify(message(e));
      throw e;
    }
  };
  useEffect(() => {
    api("/me")
      .then((r) => setUser(r.user))
      .catch(() => {})
      .finally(() => setAuthLoading(false));
    const navigate = () => {
      const h = location.hash.slice(1);
      if (h.startsWith("consent=")) {
        setConsent(h.slice(8));
        setRoute("dashboard");
      } else if (h.startsWith("join=")) {
        setConsent("");
        setRoute("groups");
      } else {
        setConsent("");
        setRoute(names[h] ? h : "dashboard");
      }
    };
    navigate();
    addEventListener("hashchange", navigate);
    return () => removeEventListener("hashchange", navigate);
  }, []);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const dataKey = user.id + ":" + route;
    if (loadedRoute.current !== dataKey) setLoading(true);
    setError("");
    api(endpoints[route])
      .then((d) => {
        if (alive) {
          loadedRoute.current = dataKey;
          setData(d);
        }
      })
      .catch((e) => {
        if (alive && e instanceof ApiError && e.code === "LOGIN_REQUIRED") {
          setUser(null);
          setData({});
          setModal(null);
          loadedRoute.current = "";
        }
        if (alive) setError(message(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [route, user?.id, refresh]);
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        [
          "dashboard",
          "tasks",
          "experience",
          "jobs",
          "resumes",
          "applications",
          "interviews",
          "career",
        ].includes(route) &&
        !modal
      )
        reload();
    }, 10000);
    return () => clearInterval(interval);
  }, [route, user?.id, modal]);
  useEffect(() => {
    if (!user || !location.hash.startsWith("#join=")) return;
    const token = location.hash.slice(6);
    setModal({
      title: "加入求職小組",
      intro: "加入後可查看小組共享內容，私人履歷與申請進度不會自動分享。",
      fields: [],
      submit: "確認加入",
      action: async () => {
        await run(() => api("/groups/join", "POST", { token }));
        location.hash = "groups";
      },
    });
  }, [user?.id]);
  if (authLoading)
    return (
      <main className="loading-screen">
        CareerOS <span>正在開啟你的工作台…</span>
      </main>
    );
  if (!user) return <Auth onLogin={setUser} />;
  const pages: Record<string, React.ReactNode> = {
    dashboard: <Dashboard />,
    experience: <Experience />,
    resumes: <Resumes />,
    jobs: <Jobs />,
    applications: <Applications />,
    interviews: <Interviews />,
    offers: <Offers />,
    collections: <Collections />,
    groups: <Groups />,
    career: <Career />,
    tasks: <Tasks />,
    settings: <Settings />,
  };
  return (
    <Context.Provider value={{ user, data, run, form, go, notify, reload }}>
      <div className="app">
        <aside className={"sidebar " + (mobile ? "open" : "")}>
          <a className="wordmark" href="#dashboard">
            CareerOS<span>你的下一站，從這裡開始</span>
          </a>
          <button
            className="sidebar-close"
            aria-label="關閉導覽"
            onClick={() => setMobile(false)}
          >
            ×
          </button>
          <nav aria-label="主要導覽">
            {Object.entries(names).map(([key, label], i) => (
              <a
                href={"#" + key}
                key={key}
                className={route === key ? "active" : ""}
                onClick={() => setMobile(false)}
              >
                <span className="nav-index">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {label}
              </a>
            ))}
          </nav>
          <div className="workspace-user">
            <div className="avatar">{user.name.slice(0, 1)}</div>
            <div>
              <strong>{user.name}</strong>
              <small>個人資料預設私人</small>
            </div>
            <button
              className="logout"
              aria-label="登出"
              onClick={async () => {
                await api("/auth/logout", "POST", {});
                setData({});
                setModal(null);
                loadedRoute.current = "";
                setUser(null);
              }}
            >
              ↗
            </button>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div>
              <button
                className="mobile-menu secondary"
                onClick={() => setMobile(!mobile)}
                aria-label="開啟導覽"
              >
                ☰
              </button>
              <span className="muted">我的工作台</span>
              <span className="breadcrumb"> / {names[route]}</span>
            </div>
            <div className="topbar-right">
              <span className="online-dot" />
              <span>私人工作台</span>
              <span className="market-label">台灣 × 國際</span>
              <div className="avatar light">{user.name.slice(0, 1)}</div>
            </div>
          </header>
          <main className="content">
            <div className="page-title">
              <div>
                <p className="eyebrow">CAREER WORKSPACE</p>
                <h1>{consent ? "授權連接" : names[route]}</h1>
              </div>
              <span className="today">
                {new Date().toLocaleDateString("zh-TW", {
                  month: "long",
                  day: "numeric",
                  weekday: "long",
                })}
              </span>
            </div>
            {consent ? (
              <Consent request={consent} onDone={() => setConsent("")} />
            ) : error ? (
              <section className="card">
                <div className="error">{error}</div>
                <button onClick={reload}>重新載入</button>
              </section>
            ) : loading || loadedRoute.current !== user.id + ":" + route ? (
              <div className="skeleton">
                <i />
                <i />
                <i />
              </div>
            ) : (
              pages[route]
            )}
            <footer className="page-footer">
              CareerOS · 每一步，都有你的依據。
            </footer>
          </main>
        </div>
      </div>
      {modal && (
        <FormDialog
          key={modal.title}
          modal={modal}
          close={() => setModal(null)}
        />
      )}{" "}
      {toast && (
        <div role="status" className="toast">
          {toast}
          <button onClick={() => setToast("")} aria-label="關閉訊息">
            ×
          </button>
        </div>
      )}
    </Context.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.pathname.endsWith("/privacy") ? <Privacy /> : <App />}
  </React.StrictMode>,
);
