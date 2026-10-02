## Marketing Studio — unavailable

Marketing Studio (branded ad video/image with avatars, products, hooks, settings, ad references, brand kits and ad formats) is **not available through the gateway**.

Why: the catalog declares no `marketing_studio_video` or `marketing_studio_image` endpoint, and the upstream workflow is a thin client over server-side state — curated avatar and product libraries, automatic Soul Character synthesis, private ad-format templates, and URL-imported product entities. None of that is documented for direct API use, so it cannot be reimplemented here.

What to do instead:

- Say plainly that the branded-ad workflow is unavailable through MCP, and name the reason. Do not describe a generic image or video generation as if it were a Marketing Studio ad.
- Offer the catalog's honest approximation **only after saying it is a different workflow**: a general image or video generation with the brand context written into the prompt. The user still owns the product references and the brand assets.
- If the user needs this workflow, they need the upstream CLI path, which is outside this gateway.

The upstream reference documents for this surface (marketing-avatars, marketing-products, marketing-setup-items, marketing-ad-references, marketing-brand-kits, marketing-dtc-ads and marketing-modes) are deliberately not carried into this tree: they document commands that cannot run.
