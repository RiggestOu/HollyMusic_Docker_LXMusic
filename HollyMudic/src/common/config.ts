export interface WindowSize {
  id: number
  name: string
  width: number
  height: number
}

export const windowSizeList: WindowSize[] = [
  { id: 0, name: 'smaller', width: 828, height: 540 },
  { id: 1, name: 'small', width: 920, height: 600 },
  { id: 2, name: 'medium', width: 1020, height: 660 },
  { id: 3, name: 'big', width: 1114, height: 718 },
  { id: 4, name: 'larger', width: 1202, height: 776 },
]
