/** electron-vite copies `?asset` imports next to the bundle and hands back the path. */
declare module '*.png?asset' {
  const path: string
  export default path
}

declare module '*.ico?asset' {
  const path: string
  export default path
}
