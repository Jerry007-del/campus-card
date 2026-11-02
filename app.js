/**
 * 财大校园卡 PWA —— 前端逻辑
 *
 * 两种模式自动切换：
 *   · 正式模式：配置了 WORKER 地址 → 走 Cloudflare Worker 代理拿真实数据
 *   · 演示模式：没配置 → 用假数据，界面完整可看，方便先验收交互
 *
 * ★ 安全设计：
 *   · 密码不写在这里，只在用户输入时读取
 *   · 登录成功后只保存 token，密码立即丢弃
 *   · token 存在 localStorage（只在你这台手机上）
 */

/* ═══════════ 配置 ═══════════
 * 部署 Worker 后，把下面这行改成你的 Worker 地址，例如：
 *   const WORKER = "https://campus-card-proxy.xxx.workers.dev";
 */
const WORKER = "https://jerry-ai-roadmap.app.workbuddy.host";

/* 演示模式用的假数据 */
const DEMO = {
  balance: 38.5,
  name: "财大学生",
  logs: [
    { time: "今天 12:03", title: "麻辣烫", place: "二食堂", amount: 12.0 },
    { time: "今天 07:41", title: "豆浆 包子", place: "一食堂", amount: 5.5 },
    { time: "昨天 18:22", title: "米饭套餐", place: "二食堂", amount: 9.0 },
    { time: "昨天 12:10", title: "牛肉面", place: "三食堂", amount: 13.0 },
    { time: "11-01 18:05", title: "炒饭", place: "一食堂", amount: 11.0 },
    { time: "11-01 12:15", title: "米线", place: "二食堂", amount: 10.0 },
  ],
};

/* ═══════════ 工具 ═══════════ */
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "hzue_card_token";

// ★ 会话 ID：用于服务端识别「你是谁」
//   cwcsf 是 ASP.NET 会话（cookie），所以每次绑定生成一个随机 id，
//   之后所有请求都带上它，服务端就能对上你的会话。
const SESSION_ID =
  localStorage.getItem("hzue_card_sid") ||
  (() => {
    const id = "s" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    localStorage.setItem("hzue_card_sid", id);
    return id;
  })();
const USER_KEY = "hzue_card_user";

function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

function money(n) {
  return Number(n || 0).toFixed(2);
}

/** 记账的图标：按金额和关键词猜个图标 */
function iconFor(title) {
  const t = String(title || "");
  if (/面|粉|米线|馄饨|饺/.test(t)) return "🍜";
  if (/饭|炒饭|盖浇/.test(t)) return "🍚";
  if (/麻辣|火锅|串串|麻辣烫/.test(t)) return "🍲";
  if (/包子|馒头|豆浆|粥/.test(t)) return "🥟";
  if (/肉|鸡|牛|排|炸/.test(t)) return "🍗";
  if (/菜|蔬|沙拉/.test(t)) return "🥬";
  if (/牛奶|饮|水|果/.test(t)) return "🥤";
  return "🍽️";
}

/* ═══════════ 渲染 ═══════════ */
function render(data) {
  $("balance").textContent = money(data.balance);

  // 同步提示
  const hint = $("syncHint");
  const now = new Date();
  hint.className = "hint";
  if (data.balance < 20) {
    hint.classList.add(data.balance < 0 ? "late" : "warn");
    hint.textContent = data.balance < 0 ? "余额已透支，尽快充值" : "余额偏低，建议尽快充值";
  } else {
    hint.textContent = `更新于 ${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
  }

  // 最近消费
  const list = $("recentList");
  const logs = (data.logs || []).slice(0, 5);
  if (!logs.length) {
    list.innerHTML = '<div class="card empty">暂无消费记录</div>';
  } else {
    list.innerHTML = logs
      .map(
        (l) => `
      <div class="card item">
        <div class="ic">${iconFor(l.title)}</div>
        <div class="mid">
          <b>${escapeHtml(l.title || "消费")}</b>
          <span>${escapeHtml(l.time || "")} · ${escapeHtml(l.place || "")}</span>
        </div>
        <div class="amt2 minus">-${money(l.amount)}</div>
      </div>`
      )
      .join("");
  }

  // 本月统计
  const monthTotal = (data.logs || [])
    .filter((l) => !/昨天|前天/.test(l.time || ""))
    .reduce((s, l) => s + Number(l.amount || 0), 0);
  $("monthAmt").textContent = "¥" + money(monthTotal);

  // 进度条：以 500 元为月度参考上限
  const pct = Math.min(100, (monthTotal / 500) * 100);
  requestAnimationFrame(() => ($("monthBar").style.width = pct + "%"));

  const days = new Date().getDate();
  $("dayAvg").textContent = "¥" + money(monthTotal / Math.max(1, days));
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ═══════════ 数据获取 ═══════════ */
async function fetchData() {
  const token = localStorage.getItem(TOKEN_KEY);

  if (!WORKER) {
    // 演示模式（没有配置代理地址时）
    await new Promise((r) => setTimeout(r, 500));
    render({ ...DEMO, balance: DEMO.balance + (Math.random() * 2 - 1).toFixed(2) });
    return;
  }

  // ★ cwcsf 用的是「服务端会话 cookie」而不是 token，
  //   所以只要带上 sessionId，服务端就知道你是谁。
  const res = await fetch(
    `${WORKER}/card-api/account?sid=${encodeURIComponent(SESSION_ID)}`,
    { headers: { Authorization: "Bearer " + token } }
  );

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
    toast("登录已过期，请重新绑定");
    return;
  }
  if (!res.ok) throw new Error("查询失败 " + res.status);

  render(await res.json());
}

/* ═══════════ 登录 ═══════════ */
async function doLogin() {
  const username = $("userInput").value.trim();
  const password = $("passInput").value.trim();

  if (!username || !password) {
    toast("请填写学号和查询密码");
    return;
  }

  const btn = $("loginBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="loading"></span> 绑定中…';

  try {
    if (!WORKER) {
      // 演示模式：假装成功
      await new Promise((r) => setTimeout(r, 800));
      localStorage.setItem(TOKEN_KEY, "demo-token");
      localStorage.setItem(USER_KEY, username);
    } else {
      const res = await fetch(`${WORKER}/card-api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          ltyp: loginType,          // id = 证件号 / sno = 学号
          sessionId: SESSION_ID,    // ★ 会话隔离：服务端按这个认人
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || data.msg || "绑定失败，请检查学号和密码");
      }
      // ★ 不存 token —— cwcsf 是服务端会话，用 SESSION_ID 标识
      localStorage.setItem(TOKEN_KEY, "session:" + SESSION_ID);
      localStorage.setItem(USER_KEY, username);
    }

    // ★ 密码用完立刻清掉，不留在内存里
    $("passInput").value = "";

    showMain();
    await fetchData();
    toast("绑定成功 ✅");
  } catch (e) {
    toast(e.message || "出错了");
  } finally {
    btn.disabled = false;
    btn.textContent = "绑定";
  }
}

/* ═══════════ 视图切换 ═══════════ */
function showLogin() {
  $("loginView").classList.remove("hidden");
  $("mainView").classList.add("hidden");
}
function showMain() {
  $("loginView").classList.add("hidden");
  $("mainView").classList.remove("hidden");
}

/* ═══════════ 事件 ═══════════ */
// ---- 登录方式：学号 / 身份证 ----
// ★ cwcsf 的 ltyp：id = 证件号 / sno = 学号
let loginType = "sno";

document.querySelectorAll("#loginType .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#loginType .seg-btn").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    loginType = btn.dataset.type;
    const u = $("userInput");
    u.placeholder = loginType === "id" ? "请输入身份证号" : "请输入学号";
    u.inputMode = loginType === "id" ? "text" : "numeric";
    u.value = "";
  });
});

$("loginBtn").addEventListener("click", doLogin);
$("refreshBtn").addEventListener("click", async () => {
  $("refreshBtn").textContent = "…";
  try {
    await fetchData();
    toast("已刷新");
  } catch (e) {
    toast("刷新失败：" + e.message);
  }
  $("refreshBtn").textContent = "⟳";
});

// 付款码：跳转到学校一卡通付款码页
$("payBtn").addEventListener("click", (e) => {
  e.preventDefault();
  const url = WORKER
    ? `${WORKER}/card-api/paycode`
    : "https://yktwx2.huel.edu.cn/plat/shouyeUser";
  window.open(url, "_blank");
});

/* ═══════════ 启动 ═══════════ */
(function init() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    showMain();
    fetchData();
  } else {
    showLogin();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
