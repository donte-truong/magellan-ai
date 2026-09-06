# Project assets

Store project media in the appropriate directory:

- `models/` — 3D models, textures, and related files. Keep multi-file models together in a named subdirectory.
- `animations/` — animation files such as Lottie JSON, Rive, and animated images.
- `videos/` — video files such as MP4 and WebM.
- `images/` — photographs, illustrations, icons, and other static images.

Next.js serves these files from `/assets/`. For example, `public/assets/models/product.glb` is referenced as `/assets/models/product.glb`, and `public/assets/images/product.webp` as `/assets/images/product.webp`.

Use descriptive lowercase filenames with hyphens. The `.gitkeep` files preserve empty directories in Git and can be removed once assets are added. Next.js metadata files, such as `src/app/icon.svg`, remain in their framework-defined locations.
