# Data Lifecycle Migration Map

Усі шляхи нижче відносні до `apps/pipeline/src/` (фактично це `src/data/...`).

This mapping captures every JSON migration from the legacy `data/<domain>/...` layout
to the lifecycle layout.

## Raw

- `data/assets/academy-openai.json` -> `data/raw/assets/academy-openai.json`
- `data/assets/academy-openai-resources.json` -> `data/raw/assets/academy-openai-resources.json`
- `data/assets/mcpservers.json` -> `data/raw/assets/mcpservers.json`
- `data/assets/prompts-md.json` -> `data/raw/assets/prompts-md.json`

## Normalized

- `data/daytoday/01-sichnia.json` -> `data/normalized/daytoday/01-sichnia.json`
- `data/daytoday/02-liutoho.json` -> `data/normalized/daytoday/02-liutoho.json`
- `data/daytoday/03-bereznia.json` -> `data/normalized/daytoday/03-bereznia.json`
- `data/daytoday/04-kvitnia.json` -> `data/normalized/daytoday/04-kvitnia.json`
- `data/daytoday/05-travnia.json` -> `data/normalized/daytoday/05-travnia.json`
- `data/daytoday/06-chervnia.json` -> `data/normalized/daytoday/06-chervnia.json`
- `data/daytoday/07-lypnia.json` -> `data/normalized/daytoday/07-lypnia.json`
- `data/daytoday/08-serpnia.json` -> `data/normalized/daytoday/08-serpnia.json`
- `data/daytoday/09-veresnia.json` -> `data/normalized/daytoday/09-veresnia.json`
- `data/daytoday/10-zhovtnya.json` -> `data/normalized/daytoday/10-zhovtnya.json`
- `data/daytoday/11-lystopada.json` -> `data/normalized/daytoday/11-lystopada.json`
- `data/daytoday/12-hrudnia.json` -> `data/normalized/daytoday/12-hrudnia.json`
- `data/daytoday/articles-collections.json` -> `data/normalized/daytoday/articles-collections.json`
- `data/daytoday/articles-healthy-lifestyle.json` -> `data/normalized/daytoday/articles-healthy-lifestyle.json`
- `data/daytoday/articles-interesting-facts.json` -> `data/normalized/daytoday/articles-interesting-facts.json`
- `data/daytoday/articles-movies.json` -> `data/normalized/daytoday/articles-movies.json`
- `data/daytoday/articles-recipes.json` -> `data/normalized/daytoday/articles-recipes.json`
- `data/daytoday/articles-science.json` -> `data/normalized/daytoday/articles-science.json`
- `data/daytoday/articles-self-development.json` -> `data/normalized/daytoday/articles-self-development.json`
- `data/daytoday/jokes.json` -> `data/normalized/daytoday/jokes.json`
- `data/daytoday/quotes.json` -> `data/normalized/daytoday/quotes.json`
- `data/faktypro/articles.json` -> `data/normalized/faktypro/articles.json`
- `data/pdr/auth.json` -> `data/normalized/pdr/auth.json`
- `data/pdr/tickets.json` -> `data/normalized/pdr/tickets.json`
- `data/prompts/3d-renders.json` -> `data/normalized/prompts/3d-renders.json`
- `data/prompts/anime.json` -> `data/normalized/prompts/anime.json`
- `data/prompts/architecture.json` -> `data/normalized/prompts/architecture.json`
- `data/prompts/character-design.json` -> `data/normalized/prompts/character-design.json`
- `data/prompts/chatgpt.json` -> `data/normalized/prompts/chatgpt.json`
- `data/prompts/concept-art.json` -> `data/normalized/prompts/concept-art.json`
- `data/prompts/fashion.json` -> `data/normalized/prompts/fashion.json`
- `data/prompts/featured.json` -> `data/normalized/prompts/featured.json`
- `data/prompts/flux.json` -> `data/normalized/prompts/flux.json`
- `data/prompts/hot.json` -> `data/normalized/prompts/hot.json`
- `data/prompts/interior-design.json` -> `data/normalized/prompts/interior-design.json`
- `data/prompts/landscapes.json` -> `data/normalized/prompts/landscapes.json`
- `data/prompts/logo-icon-design.json` -> `data/normalized/prompts/logo-icon-design.json`
- `data/prompts/midjourney.json` -> `data/normalized/prompts/midjourney.json`
- `data/prompts/models.json` -> `data/normalized/prompts/models.json`
- `data/prompts/nano-banana.json` -> `data/normalized/prompts/nano-banana.json`
- `data/prompts/photography.json` -> `data/normalized/prompts/photography.json`
- `data/prompts/portraits.json` -> `data/normalized/prompts/portraits.json`
- `data/prompts/sora.json` -> `data/normalized/prompts/sora.json`
- `data/prompts/stable-diffusion.json` -> `data/normalized/prompts/stable-diffusion.json`
- `data/prompts/top.json` -> `data/normalized/prompts/top.json`
- `data/recipes/recipes.json` -> `data/normalized/recipes/recipes.json`
- `data/samorozvytok/motivatory.json` -> `data/normalized/samorozvytok/motivatory.json`

## Publish-ready

- `data/tg/biography-posts.json` -> `data/publish-ready/tg/biography-posts.json`
- `data/tg/motivation-posts.json` -> `data/publish-ready/tg/motivation-posts.json`
- `data/tg/samorozvytok-posts.json` -> `data/publish-ready/tg/samorozvytok-posts.json`
