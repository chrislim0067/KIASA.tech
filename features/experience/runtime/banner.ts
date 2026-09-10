/** Console banner shown when DevTools is open (port of `_i`). Returns a disposer. */
export function startConsoleBanner(threadType: string, renderBackend: string): () => void {
  let shown = false;
  const check = (): void => {
    const widthGap = window.outerWidth - window.innerWidth > 150;
    const heightGap = window.outerHeight - window.innerHeight > 150;
    if (widthGap || heightGap) {
      if (shown) return;
      shown = true;
      clearInterval(interval);
      console.log(
        `
                  ....
      ..          .......
      ......      ........
      ........    ........
      ........    ........
      ........    ........
      ........    ........
      .........   ........
      ....................
      ............. ......
        ...........     ..
          ........
              ...

                    %cキアサ%c
          MADE BY KIASA

----------------------------------

Hello, Bonjour, こんにちは、
Fellow Developer! 👋

----------------------------------

You are currently using:

${threadType ? `Thread Type: ${threadType} 🧵` : ''}
${renderBackend ? `Render Backend: ${renderBackend} 🚀` : ''}

----------------------------------

Check out our projects on GitHub:
https://www.kiasa.tech/
  `,
        'font-size: 8px; color: #888;',
        '',
      );
    } else {
      shown = false;
    }
  };
  const interval = setInterval(check, 5000);
  check();
  return () => clearInterval(interval);
}
