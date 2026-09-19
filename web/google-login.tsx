import React, { useEffect, useRef, useState } from "react";
import { api, message } from "./api";

type Props = {
  clientId: string;
  intent: "login" | "link" | "reauth";
  invite?: () => string;
  password?: () => string;
  onSuccess: (user: Record<string, any>) => void;
  onBusy?: (busy: boolean) => void;
  disabled?: boolean;
};
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(options: Record<string, unknown>): void;
          renderButton(
            element: HTMLElement,
            options: Record<string, unknown>,
          ): void;
        };
      };
    };
  }
}
let script: Promise<void> | undefined;
function loadGoogle() {
  if (window.google?.accounts.id) return Promise.resolve();
  if (!script)
    script = new Promise<void>((resolve, reject) => {
      const element = document.createElement("script");
      element.src = "https://accounts.google.com/gsi/client";
      element.async = true;
      const timer = setTimeout(() => {
        element.remove();
        script = undefined;
        reject(new Error("Google 登入載入逾時，請重試。"));
      }, 15000);
      element.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      element.onerror = () => {
        clearTimeout(timer);
        element.remove();
        script = undefined;
        reject(new Error("無法載入 Google 登入，請確認網路或瀏覽器設定。"));
      };
      document.head.appendChild(element);
    });
  return script;
}
export function GoogleLogin(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let alive = true,
      submitting = false;
    setError("");
    setReady(false);
    host.current?.replaceChildren();
    (async () => {
      await loadGoogle();
      if (!alive) return;
      const { nonce } = await api("/auth/google/challenge", "POST", {
        intent: props.intent,
      });
      if (!alive || !host.current) return;
      window.google!.accounts.id.initialize({
        client_id: props.clientId,
        nonce,
        auto_select: false,
        callback: async (response: { credential?: string }) => {
          if (
            !alive ||
            submitting ||
            latest.current.disabled ||
            !response.credential
          )
            return;
          submitting = true;
          setBusy(true);
          latest.current.onBusy?.(true);
          try {
            const r = await api("/auth/google/complete", "POST", {
              credential: response.credential,
              ...(props.intent === "login"
                ? { invite: latest.current.invite?.() ?? "" }
                : {}),
              ...(props.intent === "link"
                ? { currentPassword: latest.current.password?.() ?? "" }
                : {}),
            });
            if (alive) latest.current.onSuccess(r.user);
          } catch (e) {
            if (alive) {
              setError(message(e));
              setReady(false);
              host.current?.replaceChildren();
            }
          } finally {
            submitting = false;
            if (alive) {
              setBusy(false);
              latest.current.onBusy?.(false);
            }
          }
        },
      });
      window.google!.accounts.id.renderButton(host.current, {
        theme: "outline",
        size: "large",
        text: "continue_with",
        locale: "zh-TW",
        width: 280,
      });
      setReady(true);
    })().catch((e) => {
      if (alive) setError(message(e));
    });
    return () => {
      alive = false;
      host.current?.replaceChildren();
    };
  }, [props.clientId, props.intent, attempt]);
  return (
    <div className="google-signin">
      <div
        ref={host}
        className={
          busy || props.disabled ? "google-button busy" : "google-button"
        }
      />
      {busy && (
        <p className="muted" role="status">
          正在驗證 Google 帳號…
        </p>
      )}
      {!ready && !busy && !error && (
        <p className="muted" role="status">
          正在載入 Google 登入…
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {error && (
        <button
          type="button"
          className="secondary"
          onClick={() => retry((n) => n + 1)}
        >
          重新載入 Google 登入
        </button>
      )}
    </div>
  );
}
