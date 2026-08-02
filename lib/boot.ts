import { DARK_QUERY, THEME_CANVAS, THEME_KEY } from "./theme";
import { PANEL_HINT_KEY, PANEL_HINT_PROPERTY } from "./panelHint";
import { WALLET_HINT_ATTRIBUTE, WALLET_HINT_KEY } from "./walletHint";

/**
 * Set on <html> while the first paint is being assembled, and removed two
 * frames later. app/globals.css keys its "Boot" block off it: while it is
 * there, no transition on the page runs.
 */
export const BOOTING_ATTRIBUTE = "data-booting";

/**
 * Set alongside it and removed later — when the page has finished loading, or
 * at the ceiling below, whichever comes first. It holds one thing: the
 * document's smooth scrolling.
 *
 * It is separate from the mark above because the two are answering different
 * questions. Transitions have to be still for the first paint and no longer;
 * holding them past that would cost a reader who presses something in the first
 * second the feedback for having pressed it. Scroll restoration is not done at
 * the first paint — a browser keeps adjusting it while the page settles, and
 * every one of those adjustments is a smooth-scrolled *animation* if the
 * document is left smooth. So that one waits for `load`.
 */
export const SETTLING_ATTRIBUTE = "data-settling";

/**
 * How long the settling mark may last if `load` never comes — a hung image, an
 * endpoint that will time out in thirty seconds. Long enough to cover an
 * ordinary load; short enough that a page whose last subresource is stuck still
 * gets its smooth scrolling back within a couple of seconds.
 */
const SETTLE_CEILING_MS = 2000;

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
 * Five things, and the first four are about the same frame:
 *
 *  - the palette, from the reader's stored answer or their system's, onto
 *    `data-theme` and `color-scheme`;
 *  - `theme-color`, which is the phone's address bar and its gesture strip —
 *    the largest single surface on the screen that the stylesheet cannot reach;
 *  - the wallet hint, so the masthead is laid out once rather than reflowed a
 *    beat later when wagmi revives a session (see lib/walletHint.ts);
 *  - the panel hint, which is the same idea for the one panel that cannot
 *    arrive with the page: the height it had here last time, reserved so the
 *    price history fills in rather than pushing the rest of the article down
 *    (see lib/panelHint.ts);
 *  - and the two marks above, which hold the page still while it opens.
 *
 * The reading half is wrapped in its own try/catch, because it runs before
 * anything else on the page and an exception here — a browser with localStorage
 * disabled by policy is enough — would take the document with it. The marks are
 * set outside that block and cleared in their own catch, because the one thing
 * worse than a page that flashes is a page left permanently unable to scroll
 * smoothly or animate anything.
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
var h=JSON.parse(localStorage.getItem(${JSON.stringify(
  PANEL_HINT_KEY
)})||"{}")[location.pathname];
if(h&&h.w===window.innerWidth&&h.h>0){r.style.setProperty(${JSON.stringify(
  PANEL_HINT_PROPERTY
)},h.h+"px");}
}catch(e){}
var b=${JSON.stringify(BOOTING_ATTRIBUTE)},s=${JSON.stringify(SETTLING_ATTRIBUTE)};
try{r.setAttribute(b,"");r.setAttribute(s,"");
var f=window.requestAnimationFrame||function(c){return setTimeout(c,0)};
f(function(){f(function(){r.removeAttribute(b);});});
var q=function(){r.removeAttribute(s);};
window.addEventListener("load",function(){f(q);});
setTimeout(q,${SETTLE_CEILING_MS});
}catch(e){r.removeAttribute(b);r.removeAttribute(s);}})();`;
