import { CHUNK_SIZE } from '../webrtc/protocol';
import type { FileReader } from '../webrtc/channel';
/** Immutable bounded synthetic source: preserves byte count, never reads the selected file. */
export class MemoryFileReader implements FileReader {
  readonly mime = 'application/octet-stream';
  readonly sourceKind = 'memory' as const;
  private readonly block = Uint8Array.from({length:CHUNK_SIZE},(_,i)=>i%251);
  constructor(public name:string,public size:number) {}
  async readAt(offset:number,length:number) {
    if(offset%CHUNK_SIZE || length>CHUNK_SIZE || offset+length>this.size) throw new Error('INVALID_MEMORY_READ');
    return this.block.subarray(0,length);
  }
}
