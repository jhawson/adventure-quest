(() => {
  const $ = (sel) => document.querySelector(sel);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  let playerId = store.get("aq.playerId");
  if (!playerId) {
    playerId = (crypto.randomUUID?.() ?? String(Math.random()).slice(2) + Date.now()).replace(/[^\w-]/g, "");
    store.set("aq.playerId", playerId);
  }

  const socket = io();
  let game = null;          // latest game state
  let transcript = [];      // story entries
  let controlsKey = "";

  // ---- helpers ------------------------------------------------------------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function md(text) {
    return esc(text.trim())
      .split(/\n{2,}/)
      .map((p) => "<p>" + p
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>")
        .replace(/\n/g, "<br>") + "</p>")
      .join("");
  }
  function show(view) {
    for (const v of ["welcome", "lobby", "game"]) $(`#view-${v}`).classList.toggle("hidden", v !== view);
  }
  let noticeTimer;
  function notice(text) {
    const el = $("#notice");
    el.textContent = text;
    el.classList.remove("hidden");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => el.classList.add("hidden"), 6000);
  }
  const me = () => game?.players.find((p) => p.id === playerId);

  // ---- connection ---------------------------------------------------------
  socket.on("connect", () => socket.emit("hello", { playerId }));
  socket.on("disconnect", () => notice("Connection lost. Reconnecting…"));
  socket.on("notice", notice);

  // ---- welcome / join -----------------------------------------------------
  const form = $("#join-form");
  try {
    const saved = JSON.parse(store.get("aq.profile") || "{}");
    for (const k of ["name", "character", "concept", "partySize"]) if (saved[k]) form.elements[k].value = saved[k];
  } catch {}

  socket.on("welcome", ({ needsAccessCode }) => {
    game = null;
    $("#access-row").classList.toggle("hidden", !needsAccessCode);
    form.elements.accessCode.required = !!needsAccessCode;
    show("welcome");
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.partySize = Number(data.partySize);
    const { accessCode, ...profile } = data;
    store.set("aq.profile", JSON.stringify(profile));
    const err = $("#join-error");
    err.classList.add("hidden");
    socket.emit("lobby:join", data, (res) => {
      if (!res?.ok) { err.textContent = res?.error || "Couldn't join."; err.classList.remove("hidden"); }
    });
  });

  // ---- lobby --------------------------------------------------------------
  socket.on("lobby:state", ({ targetSize, players }) => {
    show("lobby");
    $("#lobby-count").textContent = `${players.length} of ${targetSize ?? "?"} adventurers have gathered`;
    $("#lobby-players").innerHTML = players.map((p) =>
      `<li><strong>${esc(p.character)}</strong> <span class="hint" style="display:inline">(${esc(p.name)})${p.id === playerId ? " · you" : ""}</span>
       <span class="concept">${esc(p.concept)}</span></li>`).join("");
  });
  $("#lobby-start").onclick = () => socket.emit("lobby:start");
  $("#lobby-leave").onclick = () => socket.emit("lobby:leave");

  // ---- game ---------------------------------------------------------------
  socket.on("game:joined", ({ state, transcript: t }) => {
    game = state;
    transcript = t;
    controlsKey = "";
    show("game");
    renderStory();
    renderGame();
  });
  socket.on("game:state", (state) => { game = state; renderGame(); });
  socket.on("entry:new", (entry) => {
    transcript.push(entry);
    appendEntry(entry, true);
  });
  socket.on("entry:delta", ({ id, text }) => {
    const entry = transcript.find((e) => e.id === id);
    if (!entry) return;
    entry.text += text;
    const el = document.getElementById(`e-${id}`);
    if (el) { const stick = nearBottom(); el.innerHTML = md(entry.text); el.classList.add("cursor"); if (stick) scrollDown(); }
  });

  const story = $("#story");
  const nearBottom = () => story.scrollHeight - story.scrollTop - story.clientHeight < 120;
  const scrollDown = () => { story.scrollTop = story.scrollHeight; };

  function entryHTML(e) {
    switch (e.type) {
      case "gm": return md(e.text);
      case "system": return esc(e.text);
      case "chat": return `<span class="who">${esc(e.player)}:</span> ${esc(e.text)}`;
      case "actions": return `<div class="hint" style="margin:0 0 .3em">Round ${e.round}: the party acts</div>` +
        e.actions.map((a) => `<div><span class="who">${esc(a.character)}:</span> ${a.text ? esc(a.text) : '<span class="none">follows the party\'s lead</span>'}</div>`).join("");
      case "roll": {
        const dice = e.rolls.map((r) => `<span class="die">${r}</span>`).join("");
        const mod = e.modifier ? ` ${e.modifier > 0 ? "+" : "−"} ${Math.abs(e.modifier)}` : "";
        const verdict = e.success == null ? "" : e.success ? ` <span class="success">Success</span>` : ` <span class="failure">Failure</span>`;
        const dc = e.dc != null ? ` vs DC ${e.dc}` : "";
        const nat = e.natural ? ` <strong>${e.natural === "natural 20" ? "Natural 20!" : "Natural 1!"}</strong>` : "";
        const by = e.roller ? ` · rolled by ${esc(e.roller)}` : "";
        return `${dice}<div><div><strong>${esc(e.character)}</strong>: ${esc(e.reason)}</div>
          <div class="detail">${esc(e.notation)}${mod ? ` (${e.rolls.join(" + ")}${mod})` : ""}${dc}${by}</div></div>
          <div style="margin-left:auto;text-align:right"><div class="total">${e.total}</div><div>${verdict}${nat}</div></div>`;
      }
    }
    return "";
  }

  function appendEntry(e, live) {
    const stick = !live || nearBottom();
    story.querySelectorAll(".cursor").forEach((el) => el.classList.remove("cursor"));
    const div = document.createElement("div");
    div.className = `entry ${e.type}`;
    div.id = `e-${e.id}`;
    div.innerHTML = entryHTML(e);
    story.appendChild(div);
    if (stick) scrollDown();
  }

  function renderStory() {
    story.innerHTML = "";
    transcript.forEach((e) => appendEntry(e, false));
    scrollDown();
  }

  function renderGame() {
    if (!game) return;
    if (game.phase !== "gm") story.querySelectorAll(".cursor").forEach((el) => el.classList.remove("cursor"));
    $("#round").textContent = game.round ? `Round ${game.round}` : "";

    $("#party").innerHTML = game.players.filter((p) => !p.left).map((p) => {
      const pct = p.hp != null && p.maxHp ? Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100)) : null;
      const status = !p.connected ? "offline" : game.phase === "actions" ? (p.submitted ? "ready" : "deciding…") : "";
      return `<div class="pc ${p.id === playerId ? "me" : ""} ${p.connected ? "" : "offline"}">
        <span class="status ${p.submitted ? "ready" : ""}">${status === "ready" ? "✓ ready" : status}</span>
        <div class="name">${esc(p.character)}</div>
        <div class="player">${esc(p.name)}${p.id === playerId ? " (you)" : ""}</div>
        ${pct != null ? `<div class="hpbar ${pct <= 30 ? "low" : ""}"><div style="width:${pct}%"></div></div>
          <div class="tags">HP ${p.hp}/${p.maxHp}</div>` : ""}
        ${p.conditions.length ? `<div class="tags cond">${p.conditions.map(esc).join(", ")}</div>` : ""}
        ${p.inventory.length ? `<div class="tags">🎒 ${p.inventory.map(esc).join(", ")}</div>` : ""}
        <div class="tags" title="${esc(p.concept)}" style="font-style:italic">${esc(p.concept)}</div>
      </div>`;
    }).join("");

    renderControls();
  }

  function renderControls() {
    const c = $("#controls");
    const mine = me();
    const submitted = !!mine?.submitted;
    const rollIds = game.pendingRolls.map((r) => r.id + (game.players.find((p) => p.id === r.playerId)?.connected ? "c" : "d")).join();
    const key = `${game.phase}|${game.round}|${submitted}|${rollIds}`;

    if (key !== controlsKey) {
      controlsKey = key;
      if (game.phase === "gm" || game.phase === "starting") {
        c.innerHTML = `<div class="inner thinking">The Game Master is weaving the tale…</div>`;
      } else if (game.phase === "error") {
        c.innerHTML = `<div class="inner row" style="align-items:center"><span class="error">${esc(game.error)}</span>
          <button id="retry" class="primary">Try again</button></div>`;
        $("#retry").onclick = () => socket.emit("game:retry");
      } else if (game.phase === "rolls") {
        c.innerHTML = `<div class="inner"><div class="roll-list">${game.pendingRolls.map((r) => {
          const owner = game.players.find((p) => p.id === r.playerId);
          const dc = r.dc != null ? ` · DC ${r.dc}` : "";
          if (r.playerId === playerId)
            return `<button class="primary" data-roll="${r.id}">🎲 Roll ${esc(r.notation)} — ${esc(r.reason)}${dc}</button>`;
          if (owner && !owner.connected)
            return `<button data-roll="${r.id}">🎲 Roll for ${esc(r.character)} (${esc(r.notation)}, offline)</button>`;
          return `<span class="thinking">Waiting for ${esc(r.character)} to roll ${esc(r.notation)} (${esc(r.reason)})</span>`;
        }).join("")}</div></div>`;
        c.querySelectorAll("[data-roll]").forEach((b) => (b.onclick = () => {
          b.disabled = true;
          socket.emit("game:roll", { rollId: b.dataset.roll });
        }));
      } else if (game.phase === "actions") {
        c.innerHTML = `<div class="inner">
          <form id="action-form">
            <textarea name="text" rows="2" maxlength="600" placeholder="${submitted ? "You can revise your action until everyone is ready…" : `What does ${esc(mine?.character ?? "your character")} do?`}"></textarea>
            <button class="primary">${submitted ? "Revise" : "Act"}</button>
          </form>
          <div class="row" style="align-items:center;margin-top:.3rem">
            <p class="waiting" id="waiting"></p>
            <button id="proceed" class="small ${submitted ? "" : "hidden"}">Don't wait — proceed</button>
          </div></div>`;
        const f = $("#action-form");
        f.elements.text.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); }
        });
        f.onsubmit = (e) => {
          e.preventDefault();
          const text = f.elements.text.value.trim();
          if (!text) return;
          socket.emit("game:action", { text });
          f.elements.text.value = "";
        };
        $("#proceed").onclick = () => socket.emit("game:proceed");
        if (mine && !submitted) f.elements.text.focus();
      } else {
        c.innerHTML = "";
      }
    }

    const w = $("#waiting");
    if (w) {
      const waiting = game.players.filter((p) => !p.left && p.connected && !p.submitted).map((p) => p.character);
      w.textContent = waiting.length ? `Waiting for: ${waiting.join(", ")}` : "";
    }
  }

  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.target.elements.text;
    if (input.value.trim()) socket.emit("game:chat", { text: input.value });
    input.value = "";
  });

  $("#leave-game").onclick = () => {
    if (confirm("Leave this adventure? You won't be able to rejoin this party.")) socket.emit("game:leave");
  };
})();
