/** Vite handles stylesheet and image imports; TypeScript just needs to know they exist. */
declare module '*.css'

declare module '*.png' {
  const url: string
  export default url
}
