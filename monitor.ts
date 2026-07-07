import { createHash } from "node:crypto";
import { chromium, type BrowserContextOptions, type Page } from "playwright";
import { sendTelegramMessage } from "./message.js";
import { redis } from "./store.js";

const APPLICATIONS_URL = "https://app.testcenter.kz/profile/applications";
const AUTH_URL = "https://app.testcenter.kz/auth";
const HASH_KEY = "testcenter:applications:html-hash:normalized-v1";
const STORAGE_STATE_KEY = "testcenter:applications:storage-state";

type StorageState = NonNullable<BrowserContextOptions["storageState"]>;

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function getSavedStorageState(): Promise<StorageState | undefined> {
  const savedState = await redis.get<StorageState | string>(STORAGE_STATE_KEY);

  if (!savedState) {
    return undefined;
  }

  if (typeof savedState === "string") {
    return JSON.parse(savedState) as StorageState;
  }

  return savedState;
}

async function hasLocalStorageToken(page: Page) {
  return page.evaluate(() => Boolean(window.localStorage.getItem("token")));
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeHtmlSnapshot(html: string) {
  return html.replaceAll(
    /_ng(content|host)-[a-z]+-c\d+/g,
    (_match, type: string) => `_ng${type}`,
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function main() {
  const email = requiredEnv("BOT_EMAIL");
  const password = requiredEnv("BOT_PASSWORD");
  const storageState = await getSavedStorageState();

  const browser = await chromium.launch({ headless: true });
  const contextOptions: BrowserContextOptions = {
    viewport: { width: 1440, height: 1000 },
  };

  if (storageState) {
    contextOptions.storageState = storageState;
  }

  const context = await browser.newContext(contextOptions);

  try {
    const page = await context.newPage();

    await page.goto(APPLICATIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    if (
      page.url().startsWith(AUTH_URL) ||
      !(await hasLocalStorageToken(page))
    ) {
      await page.goto(AUTH_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      await page
        .getByPlaceholder("Электронды поштаңызды жазыңыз/ЖСН")
        .fill(email);
      await page.getByPlaceholder("Құпия сөз").fill(password);
      await page.getByRole("button", { name: "Кіру", exact: true }).click();

      await page.waitForURL((url) => !url.href.startsWith(AUTH_URL), {
        timeout: 60_000,
      });

      await page.goto(APPLICATIONS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    }

    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => undefined);

    if (
      page.url().startsWith(AUTH_URL) ||
      !(await hasLocalStorageToken(page))
    ) {
      throw new Error(
        "Authorization failed: token was not found in localStorage",
      );
    }

    const html = normalizeHtmlSnapshot(
      await page.evaluate(() => document.documentElement.outerHTML),
    );
    const currentHash = sha256(html);
    const previousHash = await redis.get<string>(HASH_KEY);

    await redis.set(STORAGE_STATE_KEY, await context.storageState());

    if (!previousHash) {
      await redis.set(HASH_KEY, currentHash);
      console.log(`Initial hash saved: ${currentHash}`);
      return;
    }

    if (previousHash !== currentHash) {
      await redis.set(HASH_KEY, currentHash);
      await sendTelegramMessage(
        [
          "Контент страницы Testcenter изменился.",
          `URL: ${APPLICATIONS_URL}`,
        ].join("\n"),
      );
      console.log(`Hash changed: ${previousHash} -> ${currentHash}`);
      return;
    }

    console.log(`No changes detected: ${currentHash}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(async (error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);

  await sendTelegramMessage(
    `Ошибка мониторинга Testcenter:\n${escapeHtml(message)}`,
  );
  process.exitCode = 1;
});
