// Client-safe constants shared between the search UI and the server-only
// `lib/api/search` module. Kept in its own file so client components can
// import the value without pulling the DB layer into the browser bundle.

// Below this length a query is too broad to be useful, so neither the client
// nor the backend runs a search.
export const MIN_QUERY_LENGTH = 2;
