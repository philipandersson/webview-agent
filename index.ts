import { renderKittyImageFromB64 } from "./src/render";
import { isObject } from "./src/util";

type Story = {
  id: string;
  title: string;
  url: string;
  hnUrl: string;
  points: string;
  comments: string;
};

type Result = Story & { pageTitle?: string; excerpt?: string; error?: string };

function parseStories(raw: unknown): Story[] {
  if (!Array.isArray(raw)) throw new Error("expected array of stories from webview");
  const out: Story[] = [];
  for (const v of raw) {
    if (!isObject(v)) continue;
    const { id, title, url, hnUrl, points, comments } = v;
    if (
      typeof id === "string" &&
      typeof title === "string" &&
      typeof url === "string" &&
      typeof hnUrl === "string" &&
      typeof points === "string" &&
      typeof comments === "string"
    ) {
      out.push({ id, title, url, hnUrl, points, comments });
    }
  }
  return out;
}

const extractTopStoriesJs = `
  Array.from(document.querySelectorAll('tr.athing')).slice(0, 5).map(row => {
    const titleEl = row.querySelector('.titleline > a');
    const subtext = row.nextElementSibling && row.nextElementSibling.querySelector('.subtext');
    const hnLinks = subtext ? subtext.querySelectorAll('a') : [];
    let hnLink = null;
    for (const a of hnLinks) {
      const h = a.getAttribute('href') || '';
      if (h.startsWith('item?id=')) { hnLink = a; break; }
    }
    const href = (titleEl && titleEl.getAttribute('href')) || '';
    const absoluteUrl = href.startsWith('item?id=')
      ? 'https://news.ycombinator.com/' + href
      : href;
    const scoreEl = subtext ? subtext.querySelector('.score') : null;
    return {
      id: row.id,
      title: ((titleEl && titleEl.textContent) || '').trim(),
      url: absoluteUrl,
      hnUrl: hnLink ? 'https://news.ycombinator.com/' + hnLink.getAttribute('href') : '',
      points: (scoreEl ? scoreEl.textContent : '').trim(),
      comments: hnLink ? (hnLink.textContent || '').trim() : ''
    };
  })
`;

const extractContentJs = `
  (() => {
    const title = document.title;
    const main = document.querySelector('article')
              || document.querySelector('main')
              || document.querySelector('[role="main"]')
              || document.body;
    const text = ((main && main.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 3000);
    return { title: title, text: text };
  })()
`;

await using view = new Bun.WebView({ width: 1280, height: 900 });

console.log("-> Loading Hacker News...");
await view.navigate("https://news.ycombinator.com");

const rawStories = await view.evaluate<unknown>(extractTopStoriesJs);
const stories = parseStories(rawStories);
console.log(`Got ${stories.length} top stories\n`);

const results: Result[] = [];

for (const [i, s] of stories.entries()) {
  console.log(`[${i + 1}/${stories.length}] ${s.title}`);
  console.log(`    ${s.url}`);
  try {
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("nav timeout")), 15000)
    );
    await Promise.race([view.navigate(s.url), timeout]);
    await Bun.sleep(2000);
    const content = (await view.evaluate(extractContentJs)) as { title: string; text: string };
    const b64 = await view.screenshot({ encoding: "base64", format: "png" });
    await renderKittyImageFromB64(b64, "image/png", 33);
    results.push({ ...s, pageTitle: content.title, excerpt: content.text });
    console.log(`    -> ${content.text.length} chars extracted\n`);
  } catch (err) {
    results.push({ ...s, error: String(err) });
    console.log(`    x ${err}\n`);
  }
}

console.log("\n=== RESULTS JSON ===");
console.log(JSON.stringify(results, null, 2));
