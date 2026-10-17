/** "Top 3%" reads better than "#18,342 of 600,000": `max(1, ceil(rank / of * 100))`. */
export const topPercent = (rank: number, of: number): number =>
  Math.max(1, Math.ceil((rank * 100) / of));
