import React, { useEffect, useRef, useState } from "react";
import { api, message } from "./api";
type Row = Record<string, any>;
export const accountStates: Record<string, string> = {
  waiting_client: "等待你的瀏覽器助理接手",
  working: "助理正在檢查",
  login_required: "需要登入既有帳戶",
  registration_required: "需要建立公司帳戶",
  awaiting_email: "等待 Email 驗證",
  awaiting_phone: "等待手機驗證",
  captcha_required: "需要完成驗證碼",
  password_required: "請在原網站輸入密碼",
  terms_required: "請在原網站閱讀並同意條款",
  external_login_required: "需要在外部登入頁完成登入",
  account_ready: "助理回報已登入",
  no_account_needed: "助理回報本次表單不需帳戶",
  unsupported: "目前助理無法處理",
  cancelled: "已停止協助",
};
const completed = ["account_ready", "no_account_needed", "cancelled"];
export function AccountSetupDialog({
  jobId,
  user,
  close,
}: {
  jobId: string;
  user: Row;
  close: () => void;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState("");
  const [name, setName] = useState(user.name ?? ""),
    [email, setEmail] = useState(user.email ?? "");
  const [register, setRegister] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(true),
    serial = useRef(0),
    pending = useRef(false);
  async function refresh() {
    const sequence = ++serial.current;
    try {
      const next = await api("/jobs/" + jobId + "/account-preflight");
      if (alive.current && sequence === serial.current) setData(next);
    } catch (e) {
      if (alive.current && sequence === serial.current) setError(message(e));
    }
  }
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    void refresh();
    const timer = setInterval(() => {
      if (!pending.current && document.visibilityState === "visible")
        void refresh();
    }, 5000);
    return () => {
      alive.current = false;
      serial.current++;
      clearInterval(timer);
      document.body.style.overflow = overflow;
    };
  }, [jobId]);
  async function perform(action: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    serial.current++;
    setBusy(true);
    setError("");
    try {
      await action();
      if (alive.current) {
        setConfirmed(false);
        await refresh();
      }
    } catch (e) {
      if (alive.current) {
        setError(message(e));
        await refresh();
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const runs: Row[] = data?.runs ?? [];
  const matching = runs.find((r) => r.candidate_email === email.toLowerCase());
  return (
    <dialog
      ref={dialog}
      className="dialog wide account-dialog"
      aria-labelledby="account-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header>
        <div>
          <small>申請前準備</small>
          <h2 id="account-dialog-title">登入／註冊準備</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="關閉帳戶準備"
          onClick={close}
        >
          ×
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p>正在檢查職缺網址…</p>
      ) : (
        <>
          <h3>
            {data.company} · {data.title}
          </h3>
          <div className="notice">
            CareerOS 登入只開啟你的工作台。LinkedIn、104
            或公司招募網站可能另需帳戶；同樣使用 Workday
            的不同公司也可能分別要求註冊。
          </div>
          {!data.supported ? (
            <p>
              這個網址目前無法建立帳戶協助任務。請使用單一職缺的原始網址；支援
              LinkedIn、104、Workday、Lever 與 Greenhouse
              的部分網址格式。其他網站請在原頁登入或註冊，再手動記錄投遞。
            </p>
          ) : (
            <>
              <p>
                <strong>{data.label}</strong> ·{" "}
                {data.expectation === "account_expected"
                  ? "預期需要帳戶，尚未檢查你的登入狀態。"
                  : "是否需要帳戶，要由助理檢查實際申請表單。"}
              </p>
              <a href={data.entryUrl} target="_blank" rel="noopener noreferrer">
                開啟原始職缺 ↗
              </a>
              <section className="account-execution">
                <h3>用你自己的瀏覽器助理協助</h3>
                <p>
                  先在「偏好與連接」連接具備瀏覽器操作能力的 AI
                  助理。授權後，助理可檢查帳戶、協助登入；允許註冊時可填寫姓名與
                  Email。密碼、Email／手機驗證、驗證碼及條款由你在原網站完成，再回來繼續。
                </p>
                <p className="muted">
                  網站不會自行啟動雲端瀏覽器。只有 MCP
                  連線而沒有瀏覽器工具的客戶端，無法執行這項協助。這個任務不會送出履歷。
                </p>
              </section>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void perform(() =>
                    api("/jobs/" + jobId + "/account-setup", "POST", {
                      candidateName: name.trim(),
                      candidateEmail: email.trim(),
                      allowRegistration: register,
                      confirm: true,
                    }),
                  );
                }}
              >
                <label>
                  申請人姓名
                  <input
                    required
                    maxLength={160}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setConfirmed(false);
                    }}
                  />
                </label>
                <label>
                  此網站使用的 Email
                  <input
                    required
                    type="email"
                    maxLength={254}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setConfirmed(false);
                    }}
                  />
                </label>
                {!matching && (
                  <>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={register}
                        onChange={(e) => {
                          setRegister(e.target.checked);
                          setConfirmed(false);
                        }}
                      />
                      沒有帳戶時，允許助理協助建立此網站帳戶
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        required
                        checked={confirmed}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />
                      我確認使用上述姓名與 Email，授權助理在 {data.realm}{" "}
                      協助登入{register ? "及註冊" : ""}；授權有效 24
                      小時，可隨時停止。
                    </label>
                    <button disabled={!confirmed || busy} type="submit">
                      建立帳戶協助任務
                    </button>
                  </>
                )}
              </form>
              {runs.map((run) => (
                <AccountRun
                  key={run.id + ":" + run.version}
                  run={run}
                  busy={busy}
                  perform={perform}
                />
              ))}
            </>
          )}
        </>
      )}
      <footer>
        <button
          type="button"
          className="secondary"
          onClick={() => void refresh()}
          disabled={busy}
        >
          重新檢查狀態
        </button>
        <button type="button" className="secondary" onClick={close}>
          關閉
        </button>
      </footer>
    </dialog>
  );
}
function AccountRun({
  run,
  busy,
  perform,
}: {
  run: Row;
  busy: boolean;
  perform: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [allow, setAllow] = useState(run.allow_registration);
  const expired = new Date(run.expires_at).getTime() <= Date.now();
  const prompt = `請透過 CareerOS MCP 的 account_setup_list 找到任務 ${run.id}，使用 account_setup_claim 與目前 version 領取，再讀取 account_setup_get_context。依照 context 在我的瀏覽器協助登入或註冊，並用 account_setup_report_observation 回報。遇到驗證請交給我；沒有瀏覽器工具請明確告知。不要投遞履歷。`;
  return (
    <section className="card account-run" aria-label="帳戶協助任務">
      <div className="section-head">
        <strong>
          {expired && !completed.includes(run.state)
            ? "授權已過期"
            : accountStates[run.state]}
        </strong>
        <small>{run.candidate_email}</small>
      </div>
      <small>
        網站：{run.realm} · 授權至{" "}
        {new Date(run.expires_at).toLocaleString("zh-TW")}
      </small>
      <p>{run.allow_registration ? "已允許協助註冊" : "僅協助既有帳戶登入"}</p>
      {run.state === "waiting_client" && !expired && (
        <>
          <p>把以下指令貼給已連接的助理，讓它接手這筆任務。</p>
          <textarea
            readOnly
            aria-label="給瀏覽器助理的指令"
            value={prompt}
            rows={5}
            onFocus={(e) => e.target.select()}
          />
        </>
      )}
      {run.state === "working" && !expired && (
        <p>
          正在等待助理回報。若助理中斷，可重新安排檢查；舊任務的領取權會失效。
        </p>
      )}
      {!completed.includes(run.state) &&
        run.state !== "waiting_client" &&
        run.state !== "working" && (
          <p>
            請在原網站完成上方步驟，再按「已完成，請助理再檢查」。這個按鈕不會直接標記登入成功。
          </p>
        )}
      {run.state === "unsupported" && (
        <p>
          此客戶端或頁面目前無法操作。請改用具備瀏覽器工具的助理，或在原網站手動完成。
        </p>
      )}
      {run.observed_at && (
        <p className="muted">
          助理觀察時間：{new Date(run.observed_at).toLocaleString("zh-TW")}
          {run.observed_email ? ` · ${run.observed_email}` : ""}
          。登入可能過期，投遞前仍需重新確認。
        </p>
      )}
      {run.state !== "cancelled" && (
        <label className="check">
          <input
            type="checkbox"
            checked={allow}
            onChange={(e) => setAllow(e.target.checked)}
          />
          下一次檢查允許協助註冊此網站帳戶
        </label>
      )}
      <div className="actions">
        <a
          className="button secondary"
          href={run.entry_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          前往原網站處理 ↗
        </a>
        {run.state !== "cancelled" && (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  api("/account-setups/" + run.id + "/resume", "POST", {
                    expectedVersion: run.version,
                    allowRegistration: allow,
                    confirm: true,
                  }),
                )
              }
            >
              {completed.includes(run.state) ||
              run.state === "working" ||
              run.state === "waiting_client" ||
              expired
                ? "重新授權並安排檢查"
                : "已完成，請助理再檢查"}
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  api("/account-setups/" + run.id + "/cancel", "POST", {
                    expectedVersion: run.version,
                    confirm: true,
                  }),
                )
              }
            >
              停止協助
            </button>
          </>
        )}
      </div>
      <small>
        重新安排即以此設定授權 24
        小時；助理應先檢查既有帳戶，這不代表履歷已送出。
      </small>
    </section>
  );
}
export function AccountSetups({
  items,
  user,
  onChanged,
}: {
  items: Row[];
  user: Row;
  onChanged: () => void;
}) {
  const [job, setJob] = useState<string | null>(null);
  return (
    <>
      <div className="notice">
        在「找職缺」或「投遞中心」開啟登入／註冊準備。此處保留助理的檢查進度；帳戶準備完成後，仍需另外確認投遞。
      </div>
      {items.length ? (
        items.map((r) => (
          <section className="card" key={r.id}>
            <div className="section-head">
              <div>
                <h3>{accountStates[r.state]}</h3>
                <p>
                  {r.realm} · {r.candidate_email}
                </p>
              </div>
              <button className="secondary" onClick={() => setJob(r.job_id)}>
                查看帳戶準備
              </button>
            </div>
          </section>
        ))
      ) : (
        <section className="card">
          <h3>還沒有帳戶協助任務</h3>
          <p>先保存想申請的職缺，再檢查該網站的登入與註冊需求。</p>
          <a href="#jobs">前往找職缺 →</a>
        </section>
      )}
      {job && (
        <AccountSetupDialog
          jobId={job}
          user={user}
          close={() => {
            setJob(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}
