// ---------------------------------------------------------------------------
// src/login.js — fill the CDK Common Login form and submit.
//
// The page is a React app built with styled-components, so the class names
// (sc-fUnMCh …) are build-hash garbage and useless as selectors. The stable
// hooks are the ids and data-testids, which is what this uses:
//
//   #emailId                       the email input   (name="user-name")
//   #password                      the password input
//   [data-testid="primary-button"] the Sign In button
//   #remember-me-checkbox          optional "Remember me"
//
// ## Why typing, not el.value = x
//
// React tracks the previous value on the DOM node and treats a raw
// `el.value = "..."` as a no-op — the onChange never fires, so the field looks
// filled but the component state is still empty and Sign In submits nothing.
// Real keystrokes (page.type) dispatch the input events React actually listens
// for. The field is cleared first (select-all + Backspace) because the form can
// arrive with a remembered email already in it.
// ---------------------------------------------------------------------------

const EMAIL_SEL = "#emailId";
const PASSWORD_SEL = "#password";
const SUBMIT_SEL = '[data-testid="primary-button"]';
const REMEMBER_SEL = "#remember-me-checkbox";

const email = () => process.env.CONNECTCDK_EMAIL || "";
const password = () => process.env.CONNECTCDK_PASSWORD || "";

export const hasCredentials = () => !!(email() && password());

// Clear whatever is in the field, then type the value as real keystrokes.
async function typeInto(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await page.click(selector);
  // Select-all is Meta+A on mac, Control+A elsewhere. puppeteer maps "Control"
  // fine on Windows/Linux, which is where this runs.
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.type(selector, value, { delay: 45 }); // human-ish, and React keeps up
}

/**
 * Fill the login form and click Sign In. Does NOT wait for the next page —
 * the caller owns that, so the wait logic lives in one place.
 *
 * @returns {Promise<{ startUrl: string }>} the URL at submit time, so the
 *          caller can detect "did we actually move".
 */
export async function submitLogin(page, onStage = () => {}) {
  if (!hasCredentials()) {
    throw new Error(
      "CONNECTCDK_EMAIL / CONNECTCDK_PASSWORD are not set in .env — nothing to log in with."
    );
  }

  onStage("Waiting for the login form");
  await page.waitForSelector(EMAIL_SEL, { visible: true, timeout: 30000 });

  onStage(`Typing email (${email().replace(/(.).*(@.*)/, "$1***$2")})`);
  await typeInto(page, EMAIL_SEL, email());

  onStage("Typing password");
  await typeInto(page, PASSWORD_SEL, password());

  // "Remember me" only if the caller asked for it, off by default — a persisted
  // session is a surprise nobody wants from an automated run.
  if (process.env.CONNECTCDK_REMEMBER === "true") {
    const box = await page.$(REMEMBER_SEL);
    if (box) {
      const checked = await page.evaluate((el) => el.checked, box);
      if (!checked) {
        onStage("Ticking 'Remember me'");
        await box.click();
      }
    }
  }

  const startUrl = page.url();

  onStage("Clicking Sign In");
  await page.waitForSelector(SUBMIT_SEL, { visible: true, timeout: 15000 });
  await page.click(SUBMIT_SEL);

  return { startUrl };
}
