// One adventuring party: its players, story transcript, and the turn loop
// between players and the AI Game Master.
import { randomUUID } from "node:crypto";
import { runGM, describeError } from "./gm.js";
import { DICE, rollDice, notation } from "./dice.js";

/** Strip markup characters and collapse whitespace in player-supplied text. */
export const clean = (s, max) =>
  String(s ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const clampInt = (n, lo, hi, dflt) =>
  Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : dflt;

const errorResult = (tu, text) => ({
  type: "tool_result",
  tool_use_id: tu.id,
  content: text,
  is_error: true,
});

export class Game {
  constructor({ id, io, players, onEmpty }) {
    this.id = id;
    this.io = io;
    this.room = `game:${id}`;
    this.onEmpty = onEmpty;
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      character: p.character,
      concept: p.concept,
      connected: true,
      left: false,
      hp: null,
      maxHp: null,
      conditions: [],
      inventory: [],
    }));
    this.messages = []; // Claude API history (append-only)
    this.transcript = []; // what players see
    this.phase = "starting"; // starting | gm | actions | rolls | error
    this.round = 0;
    this.actions = new Map(); // playerId -> text
    this.pendingRolls = [];
    this.pendingResults = []; // tool_results held while waiting on rolls
    this.notes = []; // out-of-band table notes for the GM's next turn
    this.error = null;
    this.busy = false;
    this.lastActivity = Date.now();
  }

  // ---- broadcasting -------------------------------------------------------

  emit(event, data) {
    this.io.to(this.room).emit(event, data);
  }

  addEntry(entry) {
    entry.id = randomUUID();
    entry.at = Date.now();
    this.transcript.push(entry);
    this.emit("entry:new", entry);
    return entry;
  }

  system(text) {
    return this.addEntry({ type: "system", text });
  }

  state() {
    return {
      id: this.id,
      phase: this.phase,
      round: this.round,
      error: this.error,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        character: p.character,
        concept: p.concept,
        connected: p.connected,
        left: p.left,
        hp: p.hp,
        maxHp: p.maxHp,
        conditions: p.conditions,
        inventory: p.inventory,
        submitted: this.actions.has(p.id),
      })),
      pendingRolls: this.pendingRolls
        .filter((r) => !r.result)
        .map((r) => ({
          id: r.id,
          playerId: r.playerId,
          character: r.character,
          notation: notation(r.dice, r.count, r.modifier),
          reason: r.reason,
          dc: r.dc,
        })),
    };
  }

  broadcast() {
    this.emit("game:state", this.state());
  }

  // ---- players ------------------------------------------------------------

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  active() {
    return this.players.filter((p) => !p.left);
  }

  findCharacter(name) {
    const n = String(name ?? "").toLowerCase().trim();
    const first = (s) => s.toLowerCase().split(/\s+/)[0];
    return (
      this.players.find((p) => p.character.toLowerCase() === n) ||
      this.players.find((p) => p.name.toLowerCase() === n) ||
      this.players.find((p) => first(p.character) === first(n))
    );
  }

  setConnected(playerId, connected) {
    const p = this.player(playerId);
    if (!p || p.left) return;
    p.connected = connected;
    this.lastActivity = Date.now();
    this.broadcast();
    if (!connected && this.phase === "actions") this.maybeResolveActions();
  }

  leave(playerId) {
    const p = this.player(playerId);
    if (!p || p.left) return;
    p.left = true;
    p.connected = false;
    this.actions.delete(playerId);
    this.notes.push(
      `${p.character} (played by ${p.name}) has left the table. Write them out of the scene gracefully.`
    );
    this.system(`${p.name} (${p.character}) has left the party.`);
    if (this.active().length === 0) {
      this.onEmpty?.();
      return;
    }
    // Nobody is left to make their rolls, so fate rolls for them.
    for (const r of this.pendingRolls.filter((r) => r.playerId === playerId && !r.result))
      this.resolveRoll(r, "Fate");
    this.broadcast();
    if (this.phase === "actions") this.maybeResolveActions();
    if (this.phase === "rolls") this.maybeFinishRolls();
  }

  isAbandoned(idleMs) {
    return (
      this.players.every((p) => !p.connected) &&
      Date.now() - this.lastActivity > idleMs
    );
  }

  // ---- the GM turn loop ---------------------------------------------------

  start() {
    const roster = this.players
      .map(
        (p) =>
          `<character name="${p.character}" player="${p.name}">${p.concept}</character>`
      )
      .join("\n");
    this.messages.push({
      role: "user",
      content: `<party>\n${roster}\n</party>\n\nBegin the adventure. First call update_character for every character to set starting HP and inventory. Then open with a vivid hook and present the party's first decision.`,
    });
    this.system(
      `The adventure begins! The party: ${this.players
        .map((p) => `${p.character} (${p.name})`)
        .join(", ")}.`
    );
    this.runGMTurn();
  }

  async runGMTurn() {
    if (this.busy) return;
    this.busy = true;
    this.phase = "gm";
    this.error = null;
    this.broadcast();
    try {
      for (;;) {
        let entry = null;
        const msg = await runGM(this.messages, (text) => {
          if (!entry) entry = this.addEntry({ type: "gm", text: "" });
          entry.text += text;
          this.emit("entry:delta", { id: entry.id, text });
        });
        this.lastActivity = Date.now();

        if (msg.stop_reason === "refusal") {
          this.system(
            "The Game Master won't take the story in that direction. Try a different course of action."
          );
          this.startActionPhase();
          return;
        }

        this.messages.push({ role: "assistant", content: msg.content });
        const toolUses = msg.content.filter((b) => b.type === "tool_use");
        if (toolUses.length === 0) {
          this.startActionPhase();
          return;
        }

        const results = [];
        for (const tu of toolUses) {
          if (msg.stop_reason === "max_tokens") {
            results.push(errorResult(tu, "Tool input was cut off. Call the tool again."));
          } else if (tu.name === "update_character") {
            results.push(this.applyUpdate(tu));
          } else if (tu.name === "request_rolls") {
            const r = this.queueRolls(tu);
            if (r) results.push(r);
          } else {
            results.push(errorResult(tu, `Unknown tool: ${tu.name}`));
          }
        }

        if (this.pendingRolls.some((r) => !r.result)) {
          // Pause until players roll; roll() resumes the loop.
          this.pendingResults = results;
          this.phase = "rolls";
          this.broadcast();
          return;
        }
        results.push(...this.collectRollResults());
        this.messages.push({ role: "user", content: results });
      }
    } catch (err) {
      console.error(`[game ${this.id}] GM error:`, err);
      this.error = describeError(err);
      this.phase = "error";
      this.system(this.error);
      this.broadcast();
    } finally {
      this.busy = false;
    }
  }

  retry() {
    if (this.phase === "error") this.runGMTurn();
  }

  // ---- tools --------------------------------------------------------------

  applyUpdate(tu) {
    const input = tu.input ?? {};
    const p = this.findCharacter(input.character);
    if (!p)
      return errorResult(
        tu,
        `No character named "${input.character}". Characters: ${this.players.map((p) => p.character).join(", ")}.`
      );
    if (Number.isInteger(input.max_hp)) p.maxHp = clampInt(input.max_hp, 1, 999);
    if (Number.isInteger(input.hp)) p.hp = clampInt(input.hp, -999, 999);
    const list = (v, n, len) =>
      Array.isArray(v) ? v.map((s) => clean(s, len)).filter(Boolean).slice(0, n) : null;
    const conditions = list(input.conditions, 8, 40);
    const inventory = list(input.inventory, 20, 60);
    if (conditions) p.conditions = conditions;
    if (inventory) p.inventory = inventory;
    this.broadcast();
    return {
      type: "tool_result",
      tool_use_id: tu.id,
      content: `Updated ${p.character}: HP ${p.hp ?? "?"}/${p.maxHp ?? "?"}; conditions: ${p.conditions.join(", ") || "none"}; inventory: ${p.inventory.join(", ") || "empty"}.`,
    };
  }

  /** Queue the requested rolls. Returns an error tool_result if the input is invalid. */
  queueRolls(tu) {
    const rolls = tu.input?.rolls;
    if (!Array.isArray(rolls) || rolls.length === 0)
      return errorResult(tu, "request_rolls needs a non-empty `rolls` array.");
    const queued = [];
    for (const r of rolls.slice(0, 8)) {
      if (!DICE.includes(r?.dice))
        return errorResult(tu, `Invalid dice "${r?.dice}". Use one of ${DICE.join(", ")}.`);
      const p = this.findCharacter(r.character);
      queued.push({
        id: randomUUID(),
        toolUseId: tu.id,
        playerId: p && !p.left ? p.id : null,
        character: p ? p.character : clean(r.character, 40) || "The world",
        dice: r.dice,
        count: clampInt(r.count, 1, 10, 1),
        modifier: clampInt(r.modifier, -10, 10, 0),
        reason: clean(r.reason, 80) || "Roll",
        dc: Number.isInteger(r.dc) ? clampInt(r.dc, 1, 100) : null,
        result: null,
      });
    }
    this.pendingRolls.push(...queued);
    // Rolls for unknown or departed characters are made by fate immediately.
    for (const r of queued) if (!r.playerId) this.resolveRoll(r, "Fate");
    return null;
  }

  resolveRoll(roll, rollerName) {
    const { rolls, total } = rollDice(roll.dice, roll.count, roll.modifier);
    const success = roll.dc == null ? null : total >= roll.dc;
    const natural =
      roll.dice === "d20" && roll.count === 1
        ? rolls[0] === 20
          ? "natural 20"
          : rolls[0] === 1
            ? "natural 1"
            : null
        : null;
    roll.result = { rolls, total, success, natural };
    this.addEntry({
      type: "roll",
      character: roll.character,
      roller: rollerName,
      notation: notation(roll.dice, roll.count, roll.modifier),
      reason: roll.reason,
      rolls,
      modifier: roll.modifier,
      total,
      dc: roll.dc,
      success,
      natural,
    });
  }

  /** A player clicks "Roll". */
  roll(playerId, rollId) {
    if (this.phase !== "rolls") return;
    const roll = this.pendingRolls.find((r) => r.id === rollId && !r.result);
    const me = this.player(playerId);
    if (!roll || !me || me.left) return;
    const owner = this.player(roll.playerId);
    // Anyone may roll on behalf of a disconnected player.
    if (roll.playerId !== playerId && owner?.connected) return;
    this.resolveRoll(roll, roll.playerId === playerId ? null : me.name);
    this.lastActivity = Date.now();
    this.broadcast();
    this.maybeFinishRolls();
  }

  maybeFinishRolls() {
    if (this.phase !== "rolls" || this.pendingRolls.some((r) => !r.result)) return;
    const results = [...this.pendingResults, ...this.collectRollResults()];
    this.pendingResults = [];
    this.messages.push({ role: "user", content: results });
    this.runGMTurn();
  }

  collectRollResults() {
    const byTool = new Map();
    for (const r of this.pendingRolls) {
      const { rolls, total, success, natural } = r.result;
      const mod = r.modifier ? ` ${r.modifier > 0 ? "+" : "-"} ${Math.abs(r.modifier)}` : "";
      let line = `${r.character} rolled ${notation(r.dice, r.count, r.modifier)} for "${r.reason}": [${rolls.join(", ")}]${mod} = ${total}`;
      if (r.dc != null) line += ` vs DC ${r.dc}: ${success ? "SUCCESS" : "FAILURE"}`;
      if (natural) line += ` (${natural}!)`;
      if (!byTool.has(r.toolUseId)) byTool.set(r.toolUseId, []);
      byTool.get(r.toolUseId).push(line);
    }
    this.pendingRolls = [];
    return [...byTool].map(([id, lines]) => ({
      type: "tool_result",
      tool_use_id: id,
      content: lines.join("\n"),
    }));
  }

  // ---- player actions -----------------------------------------------------

  startActionPhase() {
    this.phase = "actions";
    this.round += 1;
    this.actions.clear();
    this.broadcast();
  }

  submitAction(playerId, text) {
    const p = this.player(playerId);
    const action = clean(text, 600);
    if (this.phase !== "actions" || !p || p.left || !action) return;
    this.actions.set(playerId, action);
    this.lastActivity = Date.now();
    this.broadcast();
    this.maybeResolveActions();
  }

  /** Any player who has acted may tell the GM not to wait for the rest. */
  proceed(playerId) {
    if (this.phase === "actions" && this.actions.has(playerId)) this.resolveActions();
  }

  maybeResolveActions() {
    const waiting = this.active().filter((p) => p.connected && !this.actions.has(p.id));
    if (waiting.length === 0 && this.actions.size > 0) this.resolveActions();
  }

  resolveActions() {
    const list = this.active().map((p) => ({
      character: p.character,
      player: p.name,
      text: this.actions.get(p.id) ?? null,
    }));
    this.addEntry({ type: "actions", round: this.round, actions: list });
    const lines = list
      .map(
        (a) =>
          `<action character="${a.character}">${a.text ?? "(no action given; they follow the party's lead)"}</action>`
      )
      .join("\n");
    const notes = this.notes.length
      ? `<table_notes>\n${this.notes.join("\n")}\n</table_notes>\n`
      : "";
    this.notes = [];
    this.messages.push({
      role: "user",
      content: `${notes}<player_actions round="${this.round}">\n${lines}\n</player_actions>`,
    });
    this.actions.clear();
    this.runGMTurn();
  }

  chat(playerId, text) {
    const p = this.player(playerId);
    const msg = clean(text, 300);
    if (!p || p.left || !msg) return;
    this.addEntry({ type: "chat", character: p.character, player: p.name, text: msg });
  }
}
