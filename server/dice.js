import { randomInt } from "node:crypto";

export const DICE = ["d4", "d6", "d8", "d10", "d12", "d20", "d100"];

/** Roll `count` dice of the given type (e.g. "d20"), fairly, on the server. */
export function rollDice(dice, count = 1, modifier = 0) {
  const sides = Number(dice.slice(1));
  const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { rolls, total };
}

/** Human-readable notation, e.g. "2d6+3". */
export function notation(dice, count, modifier) {
  const mod = modifier > 0 ? `+${modifier}` : modifier < 0 ? `${modifier}` : "";
  return `${count}${dice}${mod}`;
}
