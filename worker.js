/**
 * ══════════════════════════════════════════════════════════════
 *  Cloudflare Worker —— 财大校园卡接口代理
 *
 *  为什么需要它？
 *    学校接口（yktwx2.huel.edu.cn）没有返回 CORS 头，
 *    浏览器里的网页直接调会被拦（同源策略）。
 *    Worker 站在中间转发，就绕开了这个限制。
 *
 *  ★ 已通过 CDP 抓包确认真实接口格式（2026-11-02）：
 *    登录：POST /berserker-auth/oauth/token
 *          Content-Type: application/x-www-form-urlencoded  ← 表单格式，不是 JSON！
 *          Authorization: Basic base64("mobile_service_platform:mobile_service_platform_secret")
 *                            ↑★ 少了这个头就是 401 Unauthorized，这是之前最大的坑
 *          username / password / grant_type=password / scope=all
 *          loginFrom=h5 / logintype=snoNew / device_token=h5 / synAccessSource=h5
 *          password = 明文 + "$1$"   ← 浏览器就是这么发的，不是加密
 *          logintype: snoNew = 用学号登录，idCard = 用身份证号登录
 *
 *    带对 Basic 头后，账号密码错会返回 400「用户名或密码错误」，
 *    而不是 401 —— 这就是判断"格式对不对"的信号。
 *
 *  部署方法：
 *    1. dash.cloudflare.com → Workers & Pages → Create → Worker
 *    2. 把本文件内容整个粘进代码编辑器 → Deploy
 *    3. 复制地址（https://xxx.workers.dev）填到 app.js 顶部的 WORKER
 *
 *  ★ 无状态：不存任何用户数据。登录凭证由前端存在自己手机的 localStorage，
 *    Worker 只负责"加 CORS 头 + 转发 + 拼参数"。
 * ══════════════════════════════════════════════════════════════
 */

const SCHOOL = "https://yktwx2.huel.edu.cn";

const ALLOW = ["/api/login", "/api/account", "/api/logs", "/api/paycode"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 MicroMessenger/8.0.49";

/**
 * ★ 学校 H5 前端硬编码的 Basic 认证凭据（从 app.js 抓包得到）
 *   解码后 = mobile_service_platform:mobile_service_platform_secret
 *   少了这个请求头 → 服务器直接 401 Unauthorized，参数再对也没用
 */
const BASIC = "Basic " + btoa("mobile_service_platform:mobile_service_platform_secret");

/** 密码后缀：浏览器实际发的是「明文$1$」，$1$ 是算法标记 */
const PW_SUFFIX = "$1$";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** 学校接口的公共请求头 */
function upHeaders(extra = {}) {
  return {
    Accept: "application/json",
    Referer: `${SCHOOL}/plat/shouyeUser`,
    Origin: SCHOOL,
    "User-Agent": UA,
    ...extra,
  };
}

/** 把上游返回的凭证收集起来（token 优先，其次 cookie） */
function pickToken(data, setCookie) {
  const d = data?.data || {};
  return (
    d.access_token ||
    data?.access_token ||
    d.token ||
    data?.token ||
    d.jwtToken ||
    (setCookie || "").split(";")[0] ||
    ""
  );
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!ALLOW.includes(url.pathname)) {
      return json({ ok: false, error: "not allowed" }, 403);
    }

    try {
      switch (url.pathname) {
        /* ───────── 登录 ───────── */
        case "/api/login": {
          const body = await request.json();
          const username = String(body.username || "").trim();
          const password = String(body.password || "");
          const logintype = body.logintype === "idCard" ? "idCard" : "snoNew";

          if (!username || !password) {
            return json({ ok: false, error: "学号和密码不能为空" }, 400);
          }

          // 密码后缀固定 "$1$"（浏览器真实做法，不再穷举）
          const form = new URLSearchParams({
            username,
            password: password + PW_SUFFIX,
            grant_type: "password",
            scope: "all",
            loginFrom: "h5",
            logintype,
            device_token: "h5",
            synAccessSource: "h5",
          });

          const upstream = await fetch(`${SCHOOL}/berserker-auth/oauth/token`, {
            method: "POST",
            headers: upHeaders({
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: BASIC,
            }),
            body: form.toString(),
          });

          const text = await upstream.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            return json(
              { ok: false, error: "学校返回异常：" + text.slice(0, 120) },
              502
            );
          }

          const token = pickToken(data, upstream.headers.get("set-cookie"));
          if (token) {
            return json({
              ok: true,
              token,
              token_type: data?.token_type || data?.data?.token_type || "",
            });
          }

          // 走到这里说明格式对了、但账号密码不对
          const msg =
            data?.message || data?.msg || data?.error_description || data?.error || "";
          const friendly = /密码|password/i.test(String(msg))
            ? "学号或查询密码不正确（查询密码默认是身份证后 6 位）"
            : String(msg || "登录失败");
          return json({ ok: false, error: friendly, upstream: msg }, 401);
        }

        /* ───────── 账户信息 / 余额 ───────── */
        case "/api/account": {
          const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
          if (!token) return json({ ok: false, error: "缺少凭证" }, 401);

          const upstream = await fetch(`${SCHOOL}/berserker-base/user`, {
            headers: upHeaders({
              // ★ 前端真实做法：值必须带 "bearer " 前缀
              "synjones-auth": `bearer ${token}`,
              Authorization: `bearer ${token}`,
              Cookie: token,
            }),
          });

          const text = await upstream.text();
          let data;
            try {
            data = JSON.parse(text);
          } catch {
            return json({ ok: false, error: "上游返回非 JSON", raw: text.slice(0, 200) }, 502);
          }
          return json(normalizeAccount(data));
        }

        /* ───────── 消费流水 ───────── */
        case "/api/logs": {
          const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
          if (!token) return json({ ok: false, error: "缺少凭证" }, 401);

          const qs =
            "current=1&size=20&synAccessSource=h5&synjones-auth=" +
            encodeURIComponent(`bearer ${token}`);

          const upstream = await fetch(`${SCHOOL}/berserker-base/user/logList?${qs}`, {
            headers: upHeaders({
              "synjones-auth": `bearer ${token}`,
              Authorization: `bearer ${token}`,
              Cookie: token,
            }),
          });

          const text = await upstream.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            return json({ ok: false, error: "上游返回非 JSON", raw: text.slice(0, 200) }, 502);
          }
          return json(normalizeLogs(data));
        }

        /* ───────── 付款码：给学校页面地址 ───────── */
        case "/api/paycode": {
          return json({ ok: true, url: `${SCHOOL}/plat/shouyeUser` });
        }

        default:
          return json({ ok: false, error: "not found" }, 404);
      }
    } catch (e) {
      return json({ ok: false, error: "代理异常：" + e.message }, 502);
    }
  },
};

/* ═══════════ 返回值归一化 ═══════════ */
function normalizeAccount(data) {
  const d = data?.data || {};
  const balance =
    d.balance ?? d.amount ?? d.cardBalance ?? d.money ?? d.balanceAmount ?? d.accAmount ?? 0;
  return {
    ok: true,
    balance: Number(balance) || 0,
    name: d.name ?? d.userName ?? d.custName ?? d.nickName ?? "",
    raw: d,
  };
}

function normalizeLogs(data) {
  const src = data?.data;
  const list = Array.isArray(src)
    ? src
    : src?.list || src?.rows || src?.records || src?.content || [];

  return {
    ok: true,
    logs: (Array.isArray(list) ? list : []).map((it) => ({
      time: fmtTime(it.time || it.tradeTime || it.date || it.createTime || it.consumeTime),
      title: it.title || it.merchantName || it.consumeType || it.tradeDesc || it.remark || "消费",
      place: it.placeName || it.merchant || it.mchName || it.deptName || "",
      amount: Number(it.amount || it.tradeAmount || it.money || it.payAmount || 0),
    })),
    raw: src,
  };
}

function fmtTime(v) {
  if (!v) return "";
  const s = String(v);
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2})?:?(\d{2})?/);
  if (!m) return s;
  const [, y, mo, d, h, mi] = m;
  const today = new Date();
  const isToday = y === String(today.getFullYear()) && mo === String(today.getMonth() + 1).padStart(2, "0") && d === String(today.getDate()).padStart(2, "0");
  if (isToday) return `今天 ${h}:${mi || "00"}`;
  return `${Number(mo)}月${Number(d)}日 ${h}:${mi || "00"}`;
}
