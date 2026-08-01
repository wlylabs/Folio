import { DARK_QUERY, THEME_CANVAS, THEME_KEY } from "./theme";
import { WALLET_HINT_ATTRIBUTE, WALLET_HINT_KEY } from "./walletHint";

/**
 * Set on <html> while the first paint is being assembled, and removed a frame
 * later. app/globals.css keys its "Boot" block off it: while it is there, every
 * transition and the page's smooth scrolling are held still.
 */
export const BOOTING_ATTRIBUTE = "data-booting";

/**
 * The first thing that runs on the page.
 *
 * Everything in here has the same reason for existing: it decides how the page
 * looks, and React is too late to decide it. The earliest React can set an
 * attribute is hydration — several hundred milliseconds and one full-brightness
 * flash of paper after the browser has already painted — so a handful of lines
 * of plain script run in the document head instead, and the components below
 * only ever agree with what it already did.
 *
 * Four things, all of them about the same frame:
 *
 *  - the palette, from the reader's stored answer or their system's, onto
 *    `data-theme` and `color-scheme`;
 *  - `theme-color`, which is the phone's address bar and its gesture strip —
 *    the largest single surface on the screen that the stylesheet cannot reach;
 *  - the booting mark, cleared after two animation frames: one to get the first
 *    paint scheduled, one to be sure it has happened. A reload restores the
 *    scroll position, and with `scroll-behavior: smooth` on the document the
 *    browser *animates* its way down to it, which is a stutter on every single
 *    refresh;
 *  - the wallet hint, so the masthead is laid out once rather than reflowed a
 *    beat later when wagmi revives a session (see lib/walletHint.ts).
 *
 * The palette half is wrapped in its own try/catch, because it runs before
 * anything else on the page and an exception here — a browser with localStorage
 * disabled by policy is enough — would take the document with it. The booting
 * mark is set outside that block and cleared in its own catch, because the one
 * thing worse than a page that flashes is a page left permanently unable to
 * scroll smoothly or animate anything.
 */
export const BOOT_SCRIPT = `(function(){var d=document,r=d.documentElement;try{
var p=localStorage.getItem(${JSON.stringify(THEME_KEY)});
var t=(p==="light"||p==="dark")?p:(window.matchMedia&&window.matchMedia(${JSON.stringify(
  DARK_QUERY
)}).matches?"dark":"light");
r.dataset.theme=t;r.style.colorScheme=t;
var m=d.querySelector('meta[name="theme-color"]');
if(!m){m=d.createElement("meta");m.setAttribute("name","theme-color");(d.head||r).appendChild(m);}
m.setAttribute("content",${JSON.stringify(THEME_CANVAS)}[t]);
if(localStorage.getItem(${JSON.stringify(WALLET_HINT_KEY)})==="1"){r.setAttribute(${JSON.stringify(
  WALLET_HINT_ATTRIBUTE
)},"");}
}catch(e){}
var b=${JSON.stringify(BOOTING_ATTRIBUTE)};
try{r.setAttribute(b,"");
var f=window.requestAnimationFrame||function(c){return setTimeout(c,0)};
f(function(){f(function(){r.removeAttribute(b);});});
}catch(e){r.removeAttribute(b);}})();`;
