/**
 * normalize.js — strip eLead's relative-time labels out of a scraped payload
 * before it leaves the agent.
 *
 * WHY THIS EXISTS
 * ───────────────
 * eLead renders each message bubble (and some activity rows) with a RELATIVE
 * age baked into the element's innerText: "2 days ago", then "3 days ago" the
 * next day, then "5 days ago". The text of an unchanged message therefore
 * changes on every single scrape.
 *
 * The backend's recheck diff (`rcDiffMessages` in Project 1) keys new-vs-old
 * on that text. With the label still attached, yesterday's message never
 * matches today's, so it is treated as brand new and a fresh LEAD_CHECK row
 * is written on every daily recheck — even for a lead with zero real
 * activity. That is the duplicate-row bug.
 *
 * assets/content.js already strips these at extraction time. This module is
 * the second pass, applied in the agent process just before publishing. It
 * matters because the injected asset can be stale (a long-running instance,
 * a cached AMI, a partial deploy), and a payload that leaves here dirty
 * produces duplicates that are expensive to clean up downstream.
 *
 * Scrubbing here is safe to run twice — it is idempotent.
 */

// Tail-anchored on purpose: eLead appends the label at the END of the text,
// so anchoring there leaves genuine customer wording alone. "I bought a car
// 3 years ago from you" survives untouched; only a trailing label is removed.
const REL_AGO_TAIL_RX = new RegExp(
  "(?:" +
    "just\\s+now|moments?\\s+ago" +
    "|(?:about|over|almost|nearly|~)?\\s*" +
      "(?:\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|few|couple(?:\\s+of)?)\\s*" +
      "(?:sec(?:ond)?s?|min(?:ute)?s?|hrs?|hours?|days?|weeks?|months?|years?)\\s+ago" +
  ")\\s*$",
  "i",
);

// Bare labels are only stripped when glued to the preceding character with no
// space. That concatenation is the signature of eLead's label running into the
// message body ("ORION HULSEYyesterday"). "Can I come in today" keeps its word.
const REL_LABEL_TAIL_RX = /(?<=\S)(?:yesterday|today)\s*$/i;

function norm(s) {
  return String(s == null ? "" : s)
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove a trailing relative-age label. Idempotent. */
export function stripRelativeTime(s) {
  let out = norm(s);
  // Loop: a bubble can end with sender AND label ("...ORION HULSEY2 days ago").
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = norm(out.replace(REL_AGO_TAIL_RX, ""));
    out = norm(out.replace(REL_LABEL_TAIL_RX, ""));
    if (out === before) break;
  }
  return out;
}

/**
 * Scrub every textMessages sub-page in place-ish (returns a new array; the
 * message objects are shallow-copied so we never mutate the scraper's output).
 * Only `text` and `sender` carry the label — `timestamp` is eLead's absolute
 * datetime attribute and is left exactly as scraped, since the backend keys
 * on it.
 */
export function normalizeSubPages(subPages) {
  if (!Array.isArray(subPages)) return subPages;
  return subPages.map((sp) => {
    if (!sp || sp.pageType !== "textMessages" || !Array.isArray(sp.messages)) return sp;
    const messages = sp.messages.map((m) => {
      if (!m) return m;
      const text = stripRelativeTime(m.text);
      const sender = stripRelativeTime(m.sender);
      if (text === m.text && sender === m.sender) return m;
      return { ...m, text, sender };
    });
    const out = { ...sp, messages };
    // The readable transcript is rebuilt from the scrubbed messages so it
    // can't reintroduce the labels into anything that reads it downstream.
    if (typeof sp.conversationTranscript === "string") {
      out.conversationTranscript = messages
        .map((m) => {
          const who =
            m.direction === "outbound" ? "Sales" : m.direction === "inbound" ? "Customer" : "Unknown";
          const when = m.timestamp ? "[" + m.timestamp + "] " : "";
          const sender = m.sender ? " (" + m.sender + ")" : "";
          return when + who + sender + ": " + m.text;
        })
        .join("\n");
    }
    return out;
  });
}

/** Same treatment for activity-log rows, which the backend also diffs on text. */
export function normalizeActivityLog(activityLog) {
  if (!Array.isArray(activityLog)) return activityLog;
  return activityLog.map((a) => {
    if (!a) return a;
    const patch = {};
    if (typeof a.text === "string") {
      const t = stripRelativeTime(a.text);
      if (t !== a.text) patch.text = t;
    }
    if (typeof a.rawText === "string") {
      const t = stripRelativeTime(a.rawText);
      if (t !== a.rawText) patch.rawText = t;
    }
    return Object.keys(patch).length ? { ...a, ...patch } : a;
  });
}

/**
 * Normalize a full { mainData, subPages, allUrls } bundle before it is sent.
 * Returns a new object; the input is not mutated.
 */
export function normalizeScrapedPayload(combined) {
  if (!combined || typeof combined !== "object") return combined;
  const out = { ...combined };
  if (out.subPages) out.subPages = normalizeSubPages(out.subPages);
  if (out.mainData && typeof out.mainData === "object") {
    const md = { ...out.mainData };
    if (md.activityLog) md.activityLog = normalizeActivityLog(md.activityLog);
    if (md.messages) {
      md.messages = md.messages.map((m) =>
        m ? { ...m, text: stripRelativeTime(m.text), sender: stripRelativeTime(m.sender) } : m,
      );
    }
    out.mainData = md;
  }
  return out;
}