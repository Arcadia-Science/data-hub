// The most file IDs one request takes when it deletes files, restores files, or
// looks up their linked files. The web app sends a longer selection in batches
// of this size.
export const FILE_ACTION_IDS_MAX = 100;
