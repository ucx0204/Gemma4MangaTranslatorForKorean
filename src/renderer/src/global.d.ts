import type { MangaApi } from "../../preload";

declare global {
  interface Window {
    mangaApi: MangaApi;
  }
}

export {};
