# Design canon

`mockup.html` is the approved design for the docs site (human sign-off 2026-10-13, artifact version 19): landing page + one docs page, neo-mirai skin, light and dark. Open it in a browser; the bar at the top switches Landing / Docs page / theme.

- It is the reference, not shipped code. Port its tokens, type, layout and motion into `website/` as brust components.
- Its `img/…` Pokémon files are NOT committed (artwork is Nintendo/Game Freak). The site loads the same images from PokeAPI URLs, as `examples/pokedex` does: artwork `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/{id}.png`, shiny `…/official-artwork/shiny/{id}.png`, sprites `…/sprites/pokemon/{id}.png`.
- Everything in it marked Thai is dropped for now (human 2026-10-13: no Thai yet).
