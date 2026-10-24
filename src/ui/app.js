// fornax ui — plain ES module, no build step. Everything the server sends is rendered through
// text nodes (h() below), never as HTML. Styling is Tailwind: class names must appear here as
// whole strings (bun run ui:css scans this file), so variants are spelled out in the maps below.

const state = { fleet: null, fleetError: null, actions: {}, presets: [], logKinds: [], idleMinutes: 30, runs: [] };
let runSeq = 0;

// ---- styles -------------------------------------------------------------------------

const focus = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400";
const C = {
  link: "text-blue-700 hover:underline dark:text-blue-400",
  muted: "text-zinc-500 dark:text-zinc-400",
  mono: "font-mono text-[12.5px]",
  panel: "mb-3.5 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xs dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-none",
  panelHead: "flex items-baseline justify-between gap-3 border-b border-zinc-200 px-3.5 py-2.5 dark:border-zinc-800",
  h2: "text-[13px] font-semibold",
  empty: "m-0 px-3.5 py-3 text-zinc-500 dark:text-zinc-400",
  btn: `inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-zinc-300 bg-white px-2.5 font-medium text-zinc-800 hover:bg-zinc-50 hover:no-underline disabled:cursor-default disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 ${focus}`,
  btnPrimary: `inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-blue-600 bg-blue-600 px-2.5 font-medium text-white hover:bg-blue-500 disabled:cursor-default disabled:opacity-60 dark:border-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400 ${focus}`,
  btnXs: "inline-flex h-5 cursor-pointer items-center rounded px-1.5 text-[11.5px] text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
  grid: "w-full border-collapse [&_td]:border-b [&_td]:border-zinc-200 [&_td]:px-3.5 [&_td]:py-1.5 [&_td]:align-top dark:[&_td]:border-zinc-800 [&_th]:bg-zinc-50 [&_th]:px-3.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-zinc-500 dark:[&_th]:bg-zinc-800/50 dark:[&_th]:text-zinc-400 [&_tbody_tr:hover]:bg-zinc-50 dark:[&_tbody_tr:hover]:bg-zinc-800/40 [&_tr:last-child_td]:border-b-0",
  num: "text-right! tabular-nums",
  out: "m-0 mb-2 max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-2 font-mono text-[12.5px] dark:border-zinc-800 dark:bg-zinc-950",
  log: "mx-3.5 mb-2.5 mt-0 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-2 font-mono text-[12.5px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400",
  codeBlock: "block whitespace-pre-wrap break-all rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 font-mono text-[12.5px] text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200",
  input: `h-[30px] rounded-md border border-zinc-300 bg-white px-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 ${focus}`,
  textarea: `rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-[12.5px] text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 ${focus}`,
  checkbox: "accent-blue-600 dark:accent-blue-400",
};
const TIER = {
  read: "rounded bg-zinc-100 px-1.5 font-mono text-[10.5px] font-medium leading-4 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  write: "rounded bg-orange-100 px-1.5 font-mono text-[10.5px] font-medium leading-4 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  onPrimary: "rounded bg-white/20 px-1.5 font-mono text-[10.5px] font-medium leading-4 text-white",
};
const PILL = {
  ok: "inline-block rounded-full bg-emerald-50 px-2 text-[11px] font-semibold leading-[18px] text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  warn: "inline-block rounded-full bg-amber-50 px-2 text-[11px] font-semibold leading-[18px] text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  crit: "inline-block rounded-full bg-red-50 px-2 text-[11px] font-semibold leading-[18px] text-red-700 dark:bg-red-950 dark:text-red-400",
  muted: "ml-2 inline-block rounded-full bg-zinc-100 px-2 text-[11px] font-medium leading-[18px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};
const TEXT = { ok: "text-emerald-700 dark:text-emerald-400", warn: "text-amber-700 dark:text-amber-400", crit: "text-red-700 dark:text-red-400", muted: "text-zinc-500 dark:text-zinc-400" };
const STATUS = {
  running: ["text-zinc-500 dark:text-zinc-400", "bg-blue-600 dark:bg-blue-400 animate-pulse"],
  ok: ["text-emerald-700 dark:text-emerald-400", "bg-emerald-600 dark:bg-emerald-400"],
  warn: ["text-amber-700 dark:text-amber-400", "bg-amber-500 dark:bg-amber-400"],
  crit: ["text-red-700 dark:text-red-400", "bg-red-600 dark:bg-red-400"],
  failed: ["text-red-700 dark:text-red-400", "bg-red-600 dark:bg-red-400"],
};

// ---- dom ----------------------------------------------------------------------------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (id) => document.getElementById(id);
const link = (href, ...children) => h("a", { href, class: C.link }, ...children);
const mono = (text, extra = "") => h("span", { class: `${C.mono} ${extra}` }, text);
const serverHref = (name) => `#/server/${encodeURIComponent(name)}`;
const siteHref = (domain) => `#/site/${encodeURIComponent(domain)}`;

const tierHelp = {
  read: "read — never changes a server",
  write: "write — changes servers or the fleet config",
};
function tierBadge(tier, onPrimary = false) {
  return tier ? h("span", { class: onPrimary ? TIER.onPrimary : (TIER[tier] ?? TIER.read), title: tierHelp[tier] ?? "" }, tier) : null;
}

function copyButton(text) {
  return h(
    "button",
    {
      class: C.btnXs,
      type: "button",
      title: "copy",
      onclick: async (e) => {
        try {
          await navigator.clipboard.writeText(text);
          e.target.textContent = "copied";
          setTimeout(() => (e.target.textContent = "copy"), 1200);
        } catch {
          /* no clipboard: the text is selectable */
        }
      },
    },
    "copy",
  );
}

/** A command as one would type it in a terminal. */
function cliLine(command, args = [], options = {}) {
  const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
  const parts = ["fornax", command, ...args.map(quote)];
  for (const [k, v] of Object.entries(options)) {
    if (v === false || v === "" || v === undefined || v === null) continue;
    if (v === true) parts.push(`--${k}`);
    else if (Array.isArray(v)) for (const x of v) parts.push(`--${k}`, quote(x));
    else parts.push(`--${k}`, quote(String(v)));
  }
  return parts.join(" ");
}

// ---- api ----------------------------------------------------------------------------

async function api(path) {
  const res = await fetch(path, { headers: { "X-Fornax": "1" } });
  const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}`, code: "http_error" }));
  if (!res.ok) throw body;
  return body;
}

async function loadFleet() {
  try {
    state.fleet = await api("/api/fleet");
    state.fleetError = null;
  } catch (e) {
    state.fleetError = e;
  }
}

// ---- runs ---------------------------------------------------------------------------

/**
 * Runs one command on the server and streams its log into a card. `target` decides which view
 * lists the card; `then(run, ev)` runs after a successful result (e.g. plan after site add),
 * `done(run)` after any end.
 */
function startRun({ target, command, args = [], options = {}, then, done }) {
  const run = { id: ++runSeq, target, command, args, options, tier: state.actions[command]?.tier, status: "running", started: Date.now(), ended: null, then, done };
  run.ui = runCard(run);
  state.runs.unshift(run);
  mountRuns();
  stream(run);
  return run;
}

async function stream(run) {
  let finished = false;
  const handle = (ev) => {
    if (ev.t === "log") onLog(run, ev);
    else if (ev.t === "result") {
      finished = true;
      finish(run, ev.exitCode === 0 ? "ok" : run.command === "health" ? (ev.exitCode === 1 ? "warn" : "crit") : "failed", `exit ${ev.exitCode}`);
      run.ui.body.replaceChildren(renderResult(run, ev));
      if (ev.exitCode === 0 && run.then) run.then(run, ev);
    } else if (ev.t === "error") {
      finished = true;
      finish(run, "failed", ev.error.code);
      run.ui.body.replaceChildren(errorBox(ev.error));
    }
  };
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fornax": "1" },
      body: JSON.stringify({ command: run.command, args: run.args, options: run.options }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}`, code: "http_error" }));
      handle({ t: "error", error: err });
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) handle(JSON.parse(line));
      }
    }
  } catch (e) {
    if (!finished) handle({ t: "error", error: { code: "connection_lost", error: `lost the connection to fornax ui: ${e?.message ?? e}`, hint: "the command may still be running — see the terminal fornax ui runs in" } });
    return;
  }
  if (!finished) handle({ t: "error", error: { code: "connection_lost", error: "the connection ended before the command finished", hint: "fornax ui may have stopped (Ctrl-C or idle) — the command may still have run; check with the CLI" } });
}

function onLog(run, ev) {
  const line = ev.line;
  const { log } = run.ui;
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  log.hidden = false;
  const tsUrl = line.match(/https:\/\/login\.tailscale\.com\/a\/[\w-]+/)?.[0];
  const row = h("span", { class: ev.notice ? "font-semibold text-amber-700 dark:text-amber-400" : "" }, line, "\n");
  if (tsUrl) {
    const a = () => h("a", { href: tsUrl, target: "_blank", rel: "noopener noreferrer", class: C.link }, tsUrl);
    row.replaceChildren(line.slice(0, line.indexOf(tsUrl)), a(), line.slice(line.indexOf(tsUrl) + tsUrl.length), "\n");
    toast(`ts-${run.id}`, h("div", {}, h("strong", {}, "Tailscale wants a fresh login"), h("div", {}, h("a", { href: tsUrl, target: "_blank", rel: "noopener noreferrer", class: C.link }, "open the login page"), " — fornax goes on once you have")));
  }
  log.append(row);
  if (stick) log.scrollTop = log.scrollHeight;

  if (/touch your security key/i.test(line)) {
    run.ui.key.hidden = false;
    run.ui.keyText.textContent = line.replace(/^.*touch your security key\s*/i, "").replace(/^\((.*)\)$/, "$1") || "SSH is waiting";
    toast(`key-${run.id}`, h("div", { class: "flex items-center gap-2.5" }, keyDot(), h("div", {}, h("strong", {}, "Touch your security key"), h("div", { class: C.muted }, run.ui.keyText.textContent))));
  } else if (!ev.notice && !run.ui.key.hidden) {
    keyDone(run);
  }
}

const keyDot = () => h("span", { class: "relative flex size-3 flex-none" }, h("span", { class: "absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75" }), h("span", { class: "relative inline-flex size-3 rounded-full bg-amber-500" }));

function keyDone(run) {
  run.ui.key.hidden = true;
  dropToast(`key-${run.id}`);
}

function finish(run, status, detail) {
  run.status = status;
  run.detail = detail;
  run.ended = Date.now();
  keyDone(run);
  dropToast(`ts-${run.id}`);
  updateStatus(run);
  run.done?.(run);
}

const seconds = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

function updateStatus(run) {
  const { status } = run.ui;
  const took = seconds((run.ended ?? Date.now()) - run.started);
  const [text, dot] = STATUS[run.status];
  status.className = `inline-flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums ${text}`;
  const label = { running: "running", ok: "done", warn: "warning", crit: "critical", failed: "failed" }[run.status];
  status.replaceChildren(h("span", { class: `size-2 rounded-full ${dot}` }), `${label}${run.status === "failed" && run.detail ? ` · ${run.detail}` : ""} · ${took}`);
}

setInterval(() => {
  for (const r of state.runs) if (r.status === "running") updateStatus(r);
}, 1000);

function runCard(run) {
  const status = h("span", {});
  const keyText = h("span", {});
  const key = h(
    "div",
    { class: "mx-3.5 mb-2.5 flex items-center gap-2.5 rounded-md bg-amber-50 px-3 py-2 dark:bg-amber-950/60", hidden: true },
    keyDot(),
    h("div", {}, h("strong", {}, "Touch your security key"), " ", h("span", { class: C.muted }, "— ", keyText, ". A PIN dialog may be waiting behind this window.")),
  );
  const log = h("pre", { class: C.log, hidden: true });
  const body = h("div", { class: "px-3.5 pb-1.5 empty:hidden" });
  const cmd = cliLine(run.command, run.args, run.options);
  const el = h(
    "article",
    { class: "border-b border-zinc-200 last:border-b-0 dark:border-zinc-800" },
    h("header", { class: "flex items-center gap-2 px-3.5 py-2" }, tierBadge(run.tier), h("code", { class: `min-w-0 flex-1 truncate ${C.mono}`, title: cmd }, cmd), status),
    key,
    log,
    body,
  );
  const ui = { el, status, key, keyText, log, body };
  run.ui = ui;
  updateStatus(run);
  return ui;
}

function emptyRuns(target) {
  return target === "new" ? "Fill in the form: the steps (site add, plan, apply) appear here." : "Nothing run here yet. Output of the commands you start appears here, newest first.";
}

/** Puts the cards of the current view's target into its activity list. */
function mountRuns() {
  const list = $("runs");
  if (!list) return;
  const mine = state.runs.filter((r) => r.target === list.dataset.target);
  // the new-site flow reads as steps (add → plan → apply): oldest first there
  if (list.dataset.target === "new") mine.reverse();
  list.replaceChildren(...(mine.length ? mine.map((r) => r.ui.el) : [h("p", { class: C.empty }, emptyRuns(list.dataset.target))]));
}

// ---- results --------------------------------------------------------------------------

function renderResult(run, ev) {
  const r = renderers[run.command];
  const main = r ? r(ev.data, ev.human, run) : pre(ev.human);
  return h("div", {}, main, h("details", { class: "mb-2" }, h("summary", { class: `cursor-pointer text-xs ${C.muted}` }, "JSON"), h("pre", { class: `${C.out} mt-1.5` }, JSON.stringify(ev.data, null, 2))));
}

const pre = (text) => (text ? h("pre", { class: C.out }, text) : h("p", { class: `mb-2 ${C.muted}` }, "no output"));
const LEVEL = { ok: "ok", warn: "warning", crit: "critical" };

const renderers = {
  health(data) {
    const checkRow = (c) =>
      h(
        "tr",
        { class: "[&_td]:border-b [&_td]:border-zinc-200 [&_td]:py-1 [&_td]:pr-2 [&_td]:align-top dark:[&_td]:border-zinc-800" },
        h("td", { class: "w-[78px]" }, h("span", { class: PILL[c.level] }, LEVEL[c.level])),
        h("td", { class: "w-[120px] whitespace-nowrap font-medium" }, c.check),
        h("td", { class: c.level === "ok" ? C.muted : "" }, c.detail),
      );
    const fleetChecks = [data.credentials, data.tailnet].filter(Boolean);
    const section = (title, checks) => h("section", { class: "mb-2" }, h("h4", { class: "mb-1.5 mt-3 text-[12.5px] font-semibold" }, title), h("table", { class: "w-full border-collapse" }, h("tbody", {}, checks.map(checkRow))));
    return h(
      "div",
      { class: "pb-1.5" },
      h("div", { class: `text-sm font-semibold ${TEXT[data.status]}` }, data.status === "ok" ? "Healthy" : data.status === "warn" ? "Warnings" : "Critical"),
      fleetChecks.length ? section("fleet", fleetChecks) : null,
      data.servers.map((s) => section([h("span", { class: PILL[s.status] }, LEVEL[s.status]), " ", link(serverHref(s.server), s.server)], s.checks)),
    );
  },
  "ssl status"(data, human) {
    if (!data.certificates.length && !data.errors.length) return pre(human);
    const level = (c) => (!c.used_by.length ? "muted" : c.days_left < 7 ? "crit" : c.days_left < 21 ? "warn" : "ok");
    return h(
      "div",
      {},
      data.certificates.length
        ? h(
            "div",
            { class: "mb-2 overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800" },
            h(
              "table",
              { class: C.grid },
              h("thead", {}, h("tr", {}, h("th", { class: C.num }, "days"), h("th", {}, "server"), h("th", {}, "certificate"), h("th", {}, "used by"), h("th", {}, "issuer"))),
              h(
                "tbody",
                {},
                data.certificates.map((c) =>
                  h("tr", {}, h("td", { class: `${C.num} font-semibold ${TEXT[level(c)]}` }, c.days_left), h("td", {}, c.server), h("td", {}, c.name), h("td", {}, c.used_by.length ? c.used_by.join(", ") : h("span", { class: C.muted }, "unused")), h("td", { class: C.muted }, c.issuer)),
                ),
              ),
            ),
          )
        : null,
      data.errors.map((e) => errorBox({ code: "error", error: `${e.server}: ${e.error}` })),
    );
  },
  "server status"(data, human) {
    return h(
      "div",
      {},
      data.warnings.length
        ? h("ul", { class: "mb-2 list-disc rounded-md bg-amber-50 py-2 pl-7 pr-3 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300" }, data.warnings.map((w) => h("li", {}, w)))
        : h("p", { class: `mb-2 ${TEXT.ok}` }, "ok — no warnings"),
      pre(human),
    );
  },
  plan(data, human, run) {
    const actions = h("div", { class: "mb-3 flex flex-wrap items-center gap-2" });
    if (data.in_sync) actions.append(h("span", { class: PILL.ok }, "in sync"));
    else if (data.destructive) {
      const cmd = `fornax apply ${data.plan} --confirm=${data.server}`;
      actions.append(
        h("div", { class: "rounded-md bg-red-50 px-3 py-2 dark:bg-red-950/60" }, h("strong", {}, "This plan deletes things. "), "fornax ui does not apply such plans — read it, then in a terminal: ", h("code", { class: C.mono }, cmd), " ", copyButton(cmd)),
      );
    } else {
      const btn = h(
        "button",
        {
          class: C.btnPrimary,
          type: "button",
          onclick: async () => {
            const ok = await confirmAction({
              title: `Apply plan ${data.plan} to ${data.server}?`,
              body: [`${data.changes.length} change${data.changes.length === 1 ? "" : "s"} will be made on ${data.server} — exactly the ones listed in the plan. fornax refuses if the server changed since the plan was made.`, h("code", { class: C.codeBlock }, `fornax apply ${data.plan}`)],
              confirm: `Apply plan ${data.plan}`,
              tier: "write",
            });
            if (!ok) return;
            btn.disabled = true;
            btn.replaceChildren(`Applying plan ${data.plan} …`);
            startRun({
              target: run.target,
              command: "apply",
              args: [data.plan],
              done: (r) => btn.replaceChildren(r.status === "ok" ? `Plan ${data.plan} applied` : `Apply of ${data.plan} failed — see above`),
            });
          },
        },
        `Apply plan ${data.plan}`,
        tierBadge("write", true),
      );
      actions.append(btn);
    }
    return h("div", {}, pre(human), actions);
  },
};

function errorBox(err) {
  return h(
    "div",
    { class: "mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 dark:border-red-900/60 dark:bg-red-950/50" },
    h("div", { class: "flex flex-wrap items-baseline gap-2" }, h("span", { class: "font-mono text-[11.5px] font-semibold text-red-700 dark:text-red-400" }, err.code ?? "error"), h("span", { class: "font-medium" }, err.error ?? String(err))),
    err.hint ? h("pre", { class: `mt-1.5 mb-0 whitespace-pre-wrap break-words font-mono text-[12.5px] ${C.muted}` }, err.hint) : null,
    err.next ? h("div", { class: "mt-1.5" }, h("span", { class: C.muted }, "next: "), h("code", { class: C.mono }, err.next), " ", copyButton(err.next)) : null,
  );
}

// ---- toasts and confirm ---------------------------------------------------------------

function toast(id, content) {
  dropToast(id);
  $("toasts").append(h("div", { class: "rounded-lg border border-amber-400 bg-white px-3 py-2.5 shadow-lg dark:border-amber-500/70 dark:bg-zinc-900", "data-id": id }, content));
}
function dropToast(id) {
  for (const t of $("toasts").children) if (t.dataset.id === id) t.remove();
}

function confirmAction({ title, body, confirm, tier }) {
  const dlg = $("confirm");
  return new Promise((resolve) => {
    const cancel = h("button", { class: C.btn, type: "button", onclick: () => dlg.close("cancel") }, "Cancel");
    const ok = h("button", { class: C.btnPrimary, type: "button", onclick: () => dlg.close("ok") }, confirm);
    dlg.replaceChildren(
      h("h3", { class: "flex items-center gap-2 text-[15px] font-semibold" }, title, tierBadge(tier)),
      h("div", { class: `my-3 grid gap-2.5 ${C.muted}` }, body),
      h("div", { class: "flex justify-end gap-2" }, cancel, ok),
    );
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
    cancel.focus();
  });
}

// ---- views ----------------------------------------------------------------------------

function actionButton(label, command, run, opts = {}) {
  const tier = state.actions[command]?.tier;
  return h(
    "button",
    {
      class: C.btn,
      type: "button",
      title: state.actions[command]?.summary ?? "",
      onclick: async () => {
        if (opts.confirm && !(await confirmAction(opts.confirm))) return;
        startRun(run);
      },
    },
    label,
    tierBadge(tier),
  );
}

const newSiteLink = (href) => h("a", { class: C.btn, href }, "New site", tierBadge("write"));

function panel(title, aside, ...body) {
  return h("section", { class: C.panel }, h("div", { class: C.panelHead }, h("h2", { class: C.h2 }, title), aside ? h("span", { class: `text-xs ${C.muted}` }, aside) : null), h("div", { class: "overflow-x-auto" }, ...body));
}

function activity(target, title = "Activity") {
  return panel(title, null, h("div", { id: "runs", "data-target": target }));
}

function pageHead(title, meta, ...tools) {
  return h(
    "header",
    { class: "mb-3.5 flex flex-wrap items-end justify-between gap-4" },
    h("div", { class: "min-w-0" }, h("h1", { class: "flex items-center text-xl font-semibold tracking-tight" }, title), meta ? h("p", { class: `mt-1 ${C.muted}` }, meta) : null),
    tools.length ? h("div", { class: "flex flex-wrap gap-1.5" }, tools) : null,
  );
}

function crumbs(...parts) {
  return h("nav", { class: `mb-1.5 flex flex-wrap gap-1.5 text-[12.5px] ${C.muted}` }, parts.map((p, i) => [i ? h("span", { class: "text-zinc-300 dark:text-zinc-600" }, "/") : null, p]));
}

function serversOf() {
  return state.fleet?.servers ?? [];
}
function sitesOf(server) {
  return (state.fleet?.sites ?? []).filter((s) => !server || s.server === server);
}

function sitesTable(sites, withServer) {
  if (!sites.length) return h("p", { class: C.empty }, "No sites yet.");
  return h(
    "table",
    { class: C.grid },
    h("thead", {}, h("tr", {}, h("th", {}, "site"), withServer ? h("th", {}, "server") : null, h("th", {}, "preset"), h("th", {}, "php"), h("th", {}, "user"), h("th", {}, "repo"))),
    h(
      "tbody",
      {},
      sites.map((s) =>
        h(
          "tr",
          { class: s.state === "absent" ? "opacity-60" : "" },
          h("td", {}, link(siteHref(s.site), s.site), s.state === "absent" ? h("span", { class: PILL.muted }, "absent") : null),
          withServer ? h("td", {}, link(serverHref(s.server), s.server)) : null,
          h("td", {}, s.preset),
          h("td", {}, s.php),
          h("td", {}, mono(s.user)),
          h("td", {}, mono(s.repo ?? "—", C.muted)),
        ),
      ),
    ),
  );
}

function viewOverview() {
  const f = state.fleet;
  const servers = serversOf();
  return [
    pageHead(
      f.fleet,
      [mono(f.dir, "break-all"), ` · access ${f.access} · ${servers.length} server${servers.length === 1 ? "" : "s"} · ${sitesOf().length} sites`],
      actionButton("Health check", "health", { target: "fleet", command: "health", options: { all: true } }),
      actionButton("Certificates", "ssl status", { target: "fleet", command: "ssl status" }),
      servers.length ? newSiteLink("#/new") : null,
    ),
    panel(
      "Servers",
      "from the fleet config — no SSH",
      servers.length
        ? h(
            "table",
            { class: C.grid },
            h("thead", {}, h("tr", {}, h("th", {}, "server"), h("th", {}, "host"), h("th", {}, "provider"), h("th", {}, "php"), h("th", { class: C.num }, "sites"))),
            h("tbody", {}, servers.map((s) => h("tr", {}, h("td", {}, link(serverHref(s.server), s.server)), h("td", {}, mono(s.host)), h("td", {}, s.provider), h("td", {}, s.php.join(", ")), h("td", { class: C.num }, s.sites)))),
          )
        : h("p", { class: C.empty }, "No servers yet. In a terminal: ", h("code", { class: C.mono }, "fornax server add <name> --host <ip>")),
    ),
    panel("Sites", null, sitesTable(sitesOf(), true)),
    activity("fleet"),
  ];
}

function viewServer(name) {
  const s = serversOf().find((x) => x.server === name);
  if (!s) return notFound(`no server "${name}" in this fleet`);
  const t = `server:${name}`;
  const sites = sitesOf(name);
  return [
    crumbs(link("#/", "Overview"), h("span", {}, name)),
    pageHead(
      name,
      [mono(s.host), ` · ${s.provider} · PHP ${s.php.join(", ")} · ${sites.length} site${sites.length === 1 ? "" : "s"}`],
      actionButton("Status", "server status", { target: t, command: "server status", args: [name] }),
      actionButton("Health", "health", { target: t, command: "health", args: [name], options: { all: true } }),
      actionButton("Certificates", "ssl status", { target: t, command: "ssl status", args: [name] }),
      actionButton("Backups", "backup status", { target: t, command: "backup status", args: [name] }),
      actionButton("Plan", "plan", { target: t, command: "plan", args: [name] }),
      newSiteLink(`#/new/${encodeURIComponent(name)}`),
    ),
    panel("Sites", null, sitesTable(sites, false)),
    activity(t),
  ];
}

function viewSite(domain) {
  const s = sitesOf().find((x) => x.site === domain);
  if (!s) return notFound(`no site "${domain}" in this fleet`);
  const t = `site:${domain}`;
  const kind = h("select", { class: C.input, name: "kind", "aria-label": "log kind" }, state.logKinds.map((k) => h("option", { value: k }, k)));
  const lines = h("input", { class: `${C.input} w-20`, name: "lines", type: "number", min: "1", max: "10000", value: "100", "aria-label": "lines" });
  const grep = h("input", { class: `${C.input} min-w-0 flex-1`, name: "grep", type: "text", placeholder: "regex (optional)", "aria-label": "grep" });
  const showLogs = (e) => {
    e.preventDefault();
    startRun({ target: t, command: "logs", args: [domain, kind.value], options: { lines: Number(lines.value) || 100, grep: grep.value.trim() } });
  };
  const label = (text, control, extra = "") => h("label", { class: `flex items-center gap-1.5 ${C.muted} ${extra}` }, text, control);
  return [
    crumbs(link("#/", "Overview"), link(serverHref(s.server), s.server), h("span", {}, domain)),
    pageHead(
      [domain, s.state === "absent" ? h("span", { class: PILL.muted }, "absent") : null],
      ["on ", link(serverHref(s.server), s.server), ` · ${s.preset} · PHP ${s.php} · user `, mono(s.user), " · ", mono(s.repo ?? "no repo")],
      actionButton("Releases", "releases", { target: t, command: "releases", args: [domain] }),
      actionButton("Plan", "plan", { target: t, command: "plan", args: [s.server], options: { site: [domain] } }),
      actionButton(
        "Deploy",
        "deploy",
        { target: t, command: "deploy", args: [domain] },
        {
          confirm: {
            title: `Deploy ${domain} now?`,
            body: [`A new release of ${s.repo ?? "the repo"} is built on ${s.server} and switched to if it answers — the same path as push-to-deploy.`, h("code", { class: C.codeBlock }, `fornax deploy ${domain}`)],
            confirm: "Deploy",
            tier: "write",
          },
        },
      ),
    ),
    panel(
      "Logs",
      null,
      h(
        "form",
        { class: "flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5", onsubmit: showLogs },
        label("kind", kind),
        label("lines", lines),
        label("grep", grep, "min-w-44 flex-1"),
        h("button", { class: C.btn, type: "submit" }, "Show logs", tierBadge(state.actions.logs?.tier)),
      ),
    ),
    activity(t),
  ];
}

function viewNewSite(preselect) {
  const servers = serversOf();
  if (!servers.length) return notFound("add a server first: fornax server add <name> --host <ip>");
  const field = (label, control, help) =>
    h("label", { class: "grid content-start gap-1" }, h("span", { class: "text-xs font-medium" }, label), control, help ? h("span", { class: `text-[11.5px] ${C.muted}` }, help) : null);
  const check = (control, text) => h("span", { class: "flex min-h-[30px] items-center gap-1.5" }, control, text);
  const server = h("select", { class: C.input, name: "server" }, servers.map((s) => h("option", { value: s.server, selected: s.server === preselect }, s.server)));
  const domain = h("input", { class: C.input, name: "domain", type: "text", placeholder: "shop.example.com", autocomplete: "off", spellcheck: "false" });
  const preview = h("input", { class: C.checkbox, name: "preview", type: "checkbox" });
  const repo = h("input", { class: C.input, name: "repo", type: "text", placeholder: "acme/shop", autocomplete: "off", spellcheck: "false" });
  const preset = h("select", { class: C.input, name: "preset" }, state.presets.map((p) => h("option", { value: p }, p)));
  const php = h("select", { class: C.input, name: "php" });
  const db = h("select", { class: C.input, name: "db" }, h("option", { value: "" }, "none"), h("option", { value: "mysql" }, "mysql"), h("option", { value: "postgres" }, "postgres"));
  const schedule = h("input", { class: C.checkbox, name: "schedule", type: "checkbox" });
  const daemons = h("textarea", { class: C.textarea, name: "daemons", rows: "2", placeholder: "php artisan horizon", spellcheck: "false" });
  const cmdPreview = h("code", { class: C.codeBlock });
  const submit = h("button", { class: C.btnPrimary, type: "submit" }, "Add site", tierBadge("write", true));

  const fillPhp = () => {
    const s = servers.find((x) => x.server === server.value);
    php.replaceChildren(h("option", { value: "" }, "the server's default"), ...(s?.php ?? []).map((v) => h("option", { value: v }, v)));
  };
  const request = () => {
    const args = [server.value, ...(domain.value.trim() ? [domain.value.trim()] : [])];
    const options = {
      preview: preview.checked,
      repo: repo.value.trim(),
      preset: preset.value === "laravel" ? "" : preset.value,
      php: php.value,
      db: db.value,
      schedule: schedule.checked,
      daemon: daemons.value.split("\n").map((l) => l.trim()).filter(Boolean),
    };
    if (!options.daemon.length) delete options.daemon;
    return { args, options };
  };
  const refreshCmd = () => {
    const { args, options } = request();
    cmdPreview.textContent = cliLine("site add", args, options);
  };
  fillPhp();
  refreshCmd();
  server.addEventListener("change", () => (fillPhp(), refreshCmd()));

  const onsubmit = (e) => {
    e.preventDefault();
    const { args, options } = request();
    startRun({
      target: "new",
      command: "site add",
      args,
      options,
      // the CLI's next step: a plan scoped to the new site
      then: async (_run, ev) => {
        await loadFleet();
        renderSidebar();
        startRun({ target: "new", command: "plan", args: [ev.data.server], options: { site: [ev.data.added] } });
      },
    });
  };

  return [
    crumbs(link("#/", "Overview"), h("span", {}, "New site")),
    pageHead("New site", ["Adds the site to the fleet config (", mono("servers/<server>.yaml"), "), then plans it. Nothing changes on the server until you apply the plan."]),
    h(
      "section",
      { class: C.panel },
      h(
        "form",
        { class: "p-3.5", oninput: refreshCmd, onchange: refreshCmd, onsubmit },
        h(
          "div",
          { class: "grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-x-4 gap-y-3" },
          field("server", server),
          field("domain", domain, "leave empty with a preview name"),
          field("preview name", check(preview, "make one up under the fleet's preview_domain"), "with a domain as well: an extra alias"),
          field("repo", repo, "owner/name on GitHub, git@…, https://… or file:///…"),
          field("preset", preset),
          field("php", php),
          field("database", db),
          field("scheduler", check(schedule, "run the Laravel scheduler every minute")),
          field("daemons", daemons, "one command per line (supervisor)"),
        ),
        h(
          "div",
          { class: "mt-3.5 flex flex-col items-stretch justify-between gap-4 border-t border-zinc-200 pt-3 sm:flex-row sm:items-end dark:border-zinc-800" },
          h("div", { class: "grid min-w-0 gap-1" }, h("span", { class: `text-[11px] uppercase tracking-wider ${C.muted}` }, "runs"), cmdPreview),
          submit,
        ),
      ),
    ),
    activity("new", "Progress"),
  ];
}

function notFound(message) {
  return [crumbs(link("#/", "Overview")), h("div", { class: C.panel }, h("p", { class: C.empty }, message))];
}

// ---- shell ----------------------------------------------------------------------------

function routeOf() {
  const [, kind, arg] = location.hash.match(/^#\/([^/]*)\/?(.*)$/) ?? [];
  return { kind: kind || "", arg: arg ? decodeURIComponent(arg) : "" };
}

const NAV = {
  item: "flex justify-between gap-2 truncate rounded-md px-2 py-1 text-zinc-800 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800",
  active: "flex justify-between gap-2 truncate rounded-md bg-blue-50 px-2 py-1 font-medium text-blue-700 dark:bg-blue-950/70 dark:text-blue-300",
  sub: "block truncate rounded-md py-1 pl-5 pr-2 text-[12.5px] text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
  subActive: "block truncate rounded-md bg-blue-50 py-1 pl-5 pr-2 text-[12.5px] font-medium text-blue-700 dark:bg-blue-950/70 dark:text-blue-300",
};

function renderSidebar() {
  const f = state.fleet;
  $("fleet-name").textContent = f?.fleet ?? "";
  const { kind, arg } = routeOf();
  const is = (k, a) => kind === k && arg === a;
  const nav = [h("a", { href: "#/", class: kind === "" ? NAV.active : NAV.item }, "Overview"), h("div", { class: `mx-2 mb-1 mt-3.5 text-[11px] uppercase tracking-wider ${C.muted}` }, "Servers")];
  for (const s of serversOf()) {
    nav.push(h("a", { href: serverHref(s.server), class: is("server", s.server) ? NAV.active : NAV.item }, h("span", { class: "truncate" }, s.server), h("span", { class: `text-xs tabular-nums ${C.muted}` }, String(s.sites))));
    for (const site of sitesOf(s.server)) nav.push(h("a", { href: siteHref(site.site), class: is("site", site.site) ? NAV.subActive : NAV.sub }, site.site));
  }
  if (!serversOf().length) nav.push(h("p", { class: `m-0 px-2 ${C.muted}` }, "none yet"));
  $("nav").replaceChildren(...nav);
  $("side-foot").replaceChildren(
    h("div", {}, "local dashboard · 127.0.0.1 only"),
    h("div", {}, `stops after ${state.idleMinutes} min without requests`),
    h("div", {}, h("a", { href: "#", class: C.link, onclick: (e) => (e.preventDefault(), refresh()) }, "reload fleet config")),
  );
}

function render() {
  renderSidebar();
  const main = $("main");
  if (state.fleetError) {
    main.replaceChildren(pageHead("The fleet config does not load"), errorBox(state.fleetError), h("p", {}, h("a", { href: "#", class: C.link, onclick: (e) => (e.preventDefault(), refresh()) }, "try again")));
    return;
  }
  const { kind, arg } = routeOf();
  const view = kind === "server" ? viewServer(arg) : kind === "site" ? viewSite(arg) : kind === "new" ? viewNewSite(arg) : viewOverview();
  main.replaceChildren(...view);
  mountRuns();
}

async function refresh() {
  await loadFleet();
  render();
}

async function boot() {
  try {
    const meta = await api("/api/actions");
    state.actions = Object.fromEntries(meta.actions.map((a) => [a.name, a]));
    state.presets = meta.presets;
    state.logKinds = meta.log_kinds;
    state.idleMinutes = meta.idle_minutes;
  } catch (e) {
    $("main").replaceChildren(errorBox(e));
    return;
  }
  await loadFleet();
  window.addEventListener("hashchange", () => {
    render();
    $("main").focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
  render();
}

boot();
