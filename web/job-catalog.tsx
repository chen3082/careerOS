import React, { useEffect, useRef, useState } from "react";
import { api, message } from "./api";
type Row = Record<string, any>;
const time = (v: string | null) =>
  v
    ? new Date(v).toLocaleString("zh-TW", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚未更新";
const state: Record<string, string> = {
  queued: "等待更新",
  running: "正在抓取",
  idle: "已更新",
  failed: "更新失敗",
};
export function JobCatalog({
  user,
  onUse,
}: {
  user: Row;
  onUse: (
    job: Row,
    action: "save" | "apply" | "collect" | "account" | "resume",
  ) => Promise<void>;
}) {
  const [query, setQuery] = useState(""),
    [q, setQ] = useState(""),
    [market, setMarket] = useState(""),
    [source, setSource] = useState(""),
    [offset, setOffset] = useState(0);
  const [data, setData] = useState<Row>({ items: [], total: 0 }),
    [sources, setSources] = useState<Row[]>([]),
    [polling, setPolling] = useState(true);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [detail, setDetail] = useState<Row | null>(null);
  const [add, setAdd] = useState(false),
    [provider, setProvider] = useState("greenhouse"),
    [board, setBoard] = useState(""),
    [label, setLabel] = useState("");
  const gate = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(query);
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let active = true,
      running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const params = new URLSearchParams({
          q,
          market,
          offset: String(offset),
          limit: "24",
          ...(source ? { sourceId: source } : {}),
        });
        const [jobs, feed] = await Promise.all([
          api("/catalog/jobs?" + params),
          api("/catalog/sources"),
        ]);
        if (active) {
          setData(jobs);
          setSources(feed.items);
          setPolling(feed.pollingEnabled);
          setError("");
        }
      } catch (e) {
        if (active) setError(message(e));
      } finally {
        running = false;
        if (active) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [q, market, source, offset, revision]);
  const action = async (fn: () => Promise<void>) => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setNotice("");
    try {
      await fn();
      setRevision((r) => r + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      gate.current = false;
      setBusy(false);
    }
  };
  const refresh = () =>
    action(async () => {
      const selected = sources.filter(
        (s) => s.enabled && (!source || s.id === source),
      );
      if (!selected.length) {
        setNotice("目前沒有啟用的來源，請管理員新增或啟用。");
        return;
      }
      const results = await Promise.all(
        selected.map((s) =>
          api(`/catalog/sources/${s.id}/refresh`, "POST", {}),
        ),
      );
      setNotice(
        results.every((r) => r.status === "cooldown")
          ? "剛剛已檢查過這些來源。為避免重複抓取，五分鐘後可再次要求更新。"
          : "更新已排入共用佇列，完成後清單會自動更新，你可以繼續瀏覽。",
      );
    });
  const use = (
    j: Row,
    kind: "save" | "apply" | "collect" | "account" | "resume",
  ) =>
    action(async () => {
      await onUse(j, kind);
      if (kind === "save")
        setNotice("已保存到我的職缺，只有你看得到自己的申請進度。");
    });
  return (
    <section aria-label="共用職缺清單" className="catalog">
      <div className="card catalog-intro">
        <div>
          <p className="eyebrow">SHARED OPPORTUNITIES</p>
          <h2>一份清單，持續更新的機會</h2>
          <p className="muted">
            系統定期整理企業公開職缺，所有成員都能瀏覽。收藏、履歷和投遞進度只屬於你。
          </p>
        </div>
        <button disabled={busy || !sources.length} onClick={refresh}>
          {busy ? "處理中…" : "更新公開來源"}
        </button>
      </div>
      <div className="action-bar">
        <div className="filters">
          <input
            aria-label="搜尋共用職缺"
            placeholder="搜尋職位、公司或技能…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="共用職缺市場"
            value={market}
            onChange={(e) => {
              setMarket(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">所有地點</option>
            <option value="TW">台灣</option>
            <option value="US">美國</option>
            <option value="INTL">其他／地域未明</option>
          </select>
          <select
            aria-label="共用職缺來源"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">所有來源</option>
            {sources
              .filter((s) => s.enabled)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
          </select>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <details className="card catalog-sources">
        <summary>
          來源與更新狀態 · {sources.filter((s) => s.enabled).length} 個啟用來源
        </summary>
        <p className="muted">
          {polling
            ? "背景自動更新已啟用，預設每 6 小時檢查一次。"
            : "定期更新目前暫停，仍可手動要求更新。"}{" "}
          僅涵蓋下列來源；LinkedIn 與 104 尚未接入共用抓取。
        </p>
        {sources.map((s) => (
          <div className="catalog-source" key={s.id}>
            <div>
              <strong>{s.label}</strong>
              <p className="muted">
                {s.provider} · {s.enabled ? state[s.status] : "已暫停"} ·
                最近成功：{time(s.last_success_at)}
              </p>
              <small>
                每 {s.interval_hours} 小時 · 本次 {s.job_count} 筆 · 新收錄{" "}
                {s.new_count} 筆 · 內容更新 {s.changed_count} 筆
                {s.last_success_at && !s.complete ? " · 僅部分結果" : ""}
              </small>
              {s.last_error && (
                <p className="error">
                  來源暫時無法更新（{s.last_error}），保留上次結果。下次重試：
                  {time(s.next_fetch_at)}
                </p>
              )}
            </div>
            <div className="actions">
              {s.enabled && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      const r = await api(
                        `/catalog/sources/${s.id}/refresh`,
                        "POST",
                        {},
                      );
                      setNotice(
                        r.status === "cooldown"
                          ? "此來源剛剛已檢查，五分鐘後可再次要求更新。"
                          : "此來源已在更新佇列，結果會自動出現。",
                      );
                    })
                  }
                >
                  更新 {s.label}
                </button>
              )}
              {user.role === "owner" && (
                <button
                  className="link"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await api(`/catalog/sources/${s.id}`, "PATCH", {
                        enabled: !s.enabled,
                        intervalHours: s.interval_hours,
                        expectedVersion: s.version,
                      });
                    })
                  }
                >
                  {s.enabled ? "暫停" : "啟用"}
                </button>
              )}
            </div>
          </div>
        ))}
        {user.role === "owner" && (
          <>
            <button className="link" onClick={() => setAdd(!add)}>
              ＋ 新增公司來源
            </button>
            {add && (
              <form
                className="catalog-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    await api("/catalog/sources", "POST", {
                      provider,
                      board,
                      label,
                    });
                    setAdd(false);
                    setBoard("");
                    setLabel("");
                    setNotice("已加入公司來源，背景抓取完成後會更新共用清單。");
                  });
                }}
              >
                <label>
                  公司名稱
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    required
                    maxLength={100}
                  />
                </label>
                <label>
                  職涯網站
                  <select
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                  >
                    <option value="greenhouse">Greenhouse</option>
                    <option value="lever">Lever</option>
                  </select>
                </label>
                <label>
                  公司識別名稱
                  <input
                    value={board}
                    onChange={(e) => setBoard(e.target.value)}
                    required
                    pattern="[a-zA-Z0-9_-]{1,100}"
                    placeholder="例如 figma"
                  />
                </label>
                <small>
                  填職涯頁網址中的公司名稱，不需登入資訊或完整網址。
                </small>
                <button disabled={busy}>加入並開始更新</button>
              </form>
            )}
          </>
        )}
      </details>
      <div className="section-head">
        <span className="muted">
          {loading ? "載入中…" : `${data.total} 個公開職缺`}
        </span>
        <small>依首次收錄排序 · 地域依來源地點判斷</small>
      </div>
      {!!data.items.length && (
        <div className="job-grid">
          {data.items.map((j: Row) => (
            <article className="card job-card" key={j.id}>
              <div className="section-head">
                <div className="company-logo">{j.company.slice(0, 1)}</div>
                <span className="badge">
                  {j.submitted_at
                    ? "我已投遞"
                    : j.application_id
                      ? "我已建立申請"
                      : j.saved_job_id
                        ? "我已保存"
                        : "尚未保存"}
                </span>
              </div>
              <p className="company-name">{j.company}</p>
              <h2>{j.title}</h2>
              <p className="muted">{j.location || "地點待確認"}</p>
              <p className="excerpt">{j.description.slice(0, 160)}</p>
              <small>
                {j.source_label} · 首次收錄 {time(j.first_seen_at)}
                <br />
                來源最後出現 {time(j.last_seen_at)}
              </small>
              {Date.now() - new Date(j.last_seen_at).getTime() > 86400000 && (
                <small className="catalog-stale">
                  資料超過一天未確認，請查看原始職缺。
                </small>
              )}
              <div className="actions">
                <button disabled={busy} onClick={() => use(j, "apply")}>
                  準備申請
                </button>
                <button
                  className="secondary"
                  disabled={busy || Boolean(j.saved_job_id)}
                  onClick={() => use(j, "save")}
                >
                  {j.saved_job_id ? "已保存" : "保存職缺"}
                </button>
                <button className="link" onClick={() => setDetail(j)}>
                  查看詳情 →
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {!loading && !data.items.length && (
        <div className="card empty">
          <h3>
            {q || market || source
              ? "目前沒有符合條件的職缺"
              : "共用清單正在準備中"}
          </h3>
          <p>可以調整篩選條件，或更新公開來源。抓取完成後結果會自動出現。</p>
          <button disabled={busy} onClick={refresh}>
            抓取最新職缺
          </button>
        </div>
      )}
      <div className="actions catalog-pagination">
        <button
          className="secondary"
          disabled={offset === 0 || loading}
          onClick={() => setOffset((n) => Math.max(0, n - 24))}
        >
          上一頁
        </button>
        <span>第 {Math.floor(offset / 24) + 1} 頁</span>
        <button
          className="secondary"
          disabled={offset + 24 >= data.total || loading}
          onClick={() => setOffset((n) => n + 24)}
        >
          下一頁
        </button>
      </div>
      {detail && (
        <div className="overlay">
          <section
            className="dialog wide"
            role="dialog"
            aria-modal="true"
            aria-label="公開職缺詳情"
          >
            <header>
              <div>
                <small>{detail.company}</small>
                <h2>{detail.title}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="關閉公開職缺"
                onClick={() => setDetail(null)}
              >
                ×
              </button>
            </header>
            <p>{detail.location}</p>
            <div className="preserve job-description">{detail.description}</div>
            <footer>
              <a
                className="button secondary"
                href={detail.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                原始職缺 ↗
              </a>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  void use(detail, "resume");
                  setDetail(null);
                }}
              >
                產生專用履歷
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  void use(detail, "collect");
                  setDetail(null);
                }}
              >
                加入分組
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  void use(detail, "account");
                  setDetail(null);
                }}
              >
                登入／註冊準備
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
