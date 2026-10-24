// The dashboard's files are embedded as text (`with { type: "text" }`); bun-types knows only *.html, as a bundle.
declare module "*.css" {
  const text: string;
  export default text;
}
declare module "*/app.js" {
  const text: string;
  export default text;
}
