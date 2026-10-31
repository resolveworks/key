// The defaults that come in two: what a conversation starts on, and what the children it owns run on.

/** The two targets, in the order the header names them and the API takes them. */
export const TARGETS = ["conversation", "child"] as const;

/** Which default a selector edits: an ownerless conversation, or any conversation a task owns. */
export type Target = (typeof TARGETS)[number];

/** A setting's two choices; an absent one falls to whatever the setting itself decides. */
export type Defaults<T> = { conversation?: T; child?: T };

/** What a target is called where the user reads it. */
export function targetName(target: Target): string {
  return target === "child" ? "children" : "conversations";
}

/** The other target: what tab switches to. */
export function otherTarget(target: Target): Target {
  return target === "conversation" ? "child" : "conversation";
}
