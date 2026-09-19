export function Privacy() {
  return (
    <main className="privacy-page card">
      <a href="./">← 返回 CareerOS</a>
      <h1>隱私與帳戶資料</h1>
      <p className="muted">更新日期：2026 年 9 月 19 日</p>
      <h2>我們儲存什麼</h2>
      <p>
        CareerOS 儲存你輸入或上傳的個人經驗、履歷、職缺、投遞紀錄、面試與 offer
        資料，以及必要的帳戶與安全紀錄。這些資料用來提供你的求職工作台。群組成員只能看到你選擇分享至群組的內容。
      </p>
      <h2>Google 登入</h2>
      <p>
        選擇 Google 登入時，我們會驗證 Google 提供的身分憑證，儲存 Google
        帳戶識別碼、姓名和電子郵件，以建立或識別你的 CareerOS
        帳戶。我們不會取得你的 Google 密碼，也不儲存登入用的 Google access token
        或 refresh token。Google 登入不會授權 CareerOS 讀取你的 Gmail
        或日曆；這些連接需要你另行同意。
      </p>
      <h2>AI 與外部服務</h2>
      <p>
        透過 MCP 連接 AI 助理時，助理可依你授予的權限讀取或更新 CareerOS
        資料。使用你自己的 API
        金鑰產生內容時，所需的資料會傳送到你選擇的模型供應商；其處理方式也適用該供應商的條款。CareerOS
        不會因為登入而自動寄送履歷或分享全部個人資料。
      </p>
      <h2>Cookie 與保存</h2>
      <p>
        我們使用必要的登入與一次性驗證 Cookie，不使用廣告追蹤
        Cookie。服務目前託管於 Google
        Cloud，私人上傳檔案與本地備份會加密保存。Google 登入元件由 Google
        提供，使用時也適用 Google 的隱私政策。
      </p>
      <h2>匯出、解除連接與刪除</h2>
      <p>
        你可以在「設定 →
        帳戶與資料」匯出或刪除帳戶。刪除前需確認身分；平台或群組擁有者需先處理擁有權。加密本地備份最長保留七天，還原時會套用刪除紀錄。解除
        Google 登入前必須先設定 CareerOS 密碼，以保留登入方式；信箱、日曆與 MCP
        的授權請在各自設定中管理。
      </p>
      <p>
        如需產品或資料處理協助，請聯絡提供邀請碼的管理員。請勿在公開 issue
        張貼履歷、憑證或個人資料。
      </p>
      <p>
        <a
          href="https://policies.google.com/privacy"
          target="_blank"
          rel="noreferrer"
        >
          Google 隱私政策
        </a>
      </p>
    </main>
  );
}
