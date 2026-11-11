//! Fixed-size resident page pool for Hyve's fmap backend.
//!
//! The browser remains responsible for reading file ranges. This module owns
//! the resident bytes and page metadata, so the amount of mapped file data is
//! bounded by `page_size * slot_count`, independent of logical file size.

use std::cell::RefCell;

const OK: i32 = 0;
const ERR_NOT_INITIALIZED: i32 = -1;
const ERR_ALL_PINNED: i32 = -2;
const ERR_INVALID_SLOT: i32 = -3;
const ERR_INVALID_LENGTH: i32 = -4;
const ERR_OUT_OF_BOUNDS: i32 = -5;
const ERR_INVALID_CONFIG: i32 = -6;

#[derive(Clone, Copy, Debug, Default)]
struct Slot {
    page_index: u64,
    valid_bytes: u32,
    pin_count: u32,
    last_touch: u64,
    occupied: bool,
}
#[derive(Debug)]
struct Pager {
    page_size: u32,
    slots: Vec<Slot>,
    bytes: Vec<u8>,
    output: Vec<f32>,
    tick: u64,
    generation: u32,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl Pager {
    fn new(page_size: u32, slot_count: u32) -> Result<Self, i32> {
        if page_size == 0 || slot_count == 0 {
            return Err(ERR_INVALID_CONFIG);
        }
        let resident = (page_size as usize)
            .checked_mul(slot_count as usize)
            .ok_or(ERR_INVALID_CONFIG)?;
        // Keep allocations representable by the wasm32 address space.
        if resident > u32::MAX as usize {
            return Err(ERR_INVALID_CONFIG);
        }
        Ok(Self {
            page_size,
            slots: vec![Slot::default(); slot_count as usize],
            bytes: vec![0; resident],
            output: vec![0.0; (page_size / 4).max(1) as usize],
            tick: 0,
            generation: 1,
            hits: 0,
            misses: 0,
            evictions: 0,
        })
    }

    fn touch_slot(&mut self, index: usize) {
        self.tick = self.tick.wrapping_add(1).max(1);
        self.slots[index].last_touch = self.tick;
    }

    fn find(&self, page_index: u64) -> Option<usize> {
        self.slots
            .iter()
            .position(|slot| slot.occupied && slot.page_index == page_index)
    }

    fn victim(&self) -> Option<usize> {
        self.slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.pin_count == 0)
            .min_by_key(|(_, slot)| (slot.occupied, slot.last_touch))
            .map(|(index, _)| index)
    }

    fn acquire(&mut self, page_index: u64) -> i32 {
        if let Some(index) = self.find(page_index) {
            self.hits = self.hits.saturating_add(1);
            self.slots[index].pin_count = self.slots[index].pin_count.saturating_add(1);
            self.touch_slot(index);
            return index as i32;
        }
        self.misses = self.misses.saturating_add(1);
        let Some(index) = self.victim() else {
            return ERR_ALL_PINNED;
        };
        if self.slots[index].occupied {
            self.evictions = self.evictions.saturating_add(1);
        }
        self.slots[index] = Slot {
            page_index,
            valid_bytes: 0,
            pin_count: 1,
            last_touch: 0,
            occupied: true,
        };
        self.touch_slot(index);
        index as i32
    }

    fn reset(&mut self) {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.slots.fill(Slot::default());
        self.bytes.fill(0);
        self.output.fill(0.0);
        self.tick = 0;
        self.hits = 0;
        self.misses = 0;
        self.evictions = 0;
    }

    fn slot_range(&self, index: usize) -> Option<std::ops::Range<usize>> {
        if index >= self.slots.len() {
            return None;
        }
        let start = index * self.page_size as usize;
        Some(start..start + self.page_size as usize)
    }
}

thread_local! {
    static PAGER: RefCell<Option<Pager>> = const { RefCell::new(None) };
}

fn with_pager<R>(f: impl FnOnce(&Pager) -> R) -> Option<R> {
    PAGER.with(|cell| cell.borrow().as_ref().map(f))
}

fn with_pager_mut<R>(f: impl FnOnce(&mut Pager) -> R) -> Option<R> {
    PAGER.with(|cell| cell.borrow_mut().as_mut().map(f))
}

#[no_mangle]
pub extern "C" fn fmap_init(page_size: u32, slot_count: u32) -> i32 {
    match Pager::new(page_size, slot_count) {
        Ok(pager) => {
            PAGER.with(|cell| *cell.borrow_mut() = Some(pager));
            OK
        }
        Err(code) => code,
    }
}

#[no_mangle]
pub extern "C" fn fmap_reset() -> i32 {
    with_pager_mut(Pager::reset).map(|_| OK).unwrap_or(ERR_NOT_INITIALIZED)
}

#[no_mangle]
pub extern "C" fn fmap_generation() -> u32 {
    with_pager(|pager| pager.generation).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fmap_page_size() -> u32 {
    with_pager(|pager| pager.page_size).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fmap_slot_count() -> u32 {
    with_pager(|pager| pager.slots.len() as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fmap_resident_bytes() -> u32 {
    with_pager(|pager| pager.bytes.len() as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fmap_pinned_bytes() -> u32 {
    with_pager(|pager| {
        pager.slots.iter().filter(|slot| slot.pin_count > 0).count() as u32 * pager.page_size
    })
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fmap_acquire_page(page_index: u64) -> i32 {
    with_pager_mut(|pager| pager.acquire(page_index)).unwrap_or(ERR_NOT_INITIALIZED)
}

#[no_mangle]
pub extern "C" fn fmap_find_page(page_index: u64) -> i32 {
    with_pager(|pager| pager.find(page_index).map(|index| index as i32).unwrap_or(-1))
        .unwrap_or(ERR_NOT_INITIALIZED)
}

#[no_mangle]
pub extern "C" fn fmap_commit_page(slot_index: u32, valid_bytes: u32) -> i32 {
    with_pager_mut(|pager| {
        let index = slot_index as usize;
        if index >= pager.slots.len() || !pager.slots[index].occupied {
            return ERR_INVALID_SLOT;
        }
        if valid_bytes > pager.page_size {
            return ERR_INVALID_LENGTH;
        }
        pager.slots[index].valid_bytes = valid_bytes;
        pager.touch_slot(index);
        OK
    })
    .unwrap_or(ERR_NOT_INITIALIZED)
}

#[no_mangle]
pub extern "C" fn fmap_release_page(slot_index: u32) -> i32 {
    with_pager_mut(|pager| {
        let index = slot_index as usize;
        if index >= pager.slots.len() || !pager.slots[index].occupied {
            return ERR_INVALID_SLOT;
        }
        if pager.slots[index].pin_count == 0 {
            return ERR_INVALID_SLOT;
        }
        pager.slots[index].pin_count -= 1;
        pager.touch_slot(index);
        OK
    })
    .unwrap_or(ERR_NOT_INITIALIZED)
}

#[no_mangle]
pub extern "C" fn fmap_touch_page(slot_index: u32) -> i32 {
    with_pager_mut(|pager| {
        let index = slot_index as usize;
        if index >= pager.slots.len() || !pager.slots[index].occupied {
            return ERR_INVALID_SLOT;
        }
        pager.touch_slot(index);
        OK
    })
    .unwrap_or(ERR_NOT_INITIALIZED)
}

#[no_mangle]
pub extern "C" fn fmap_evict_page(page_index: u64) -> i32 {
    with_pager_mut(|pager| {
        let Some(index) = pager.find(page_index) else {
            return 0;
        };
        if pager.slots[index].pin_count > 0 {
            return ERR_ALL_PINNED;
        }
        pager.slots[index] = Slot::default();
        pager.evictions = pager.evictions.saturating_add(1);
        1
    })
    .unwrap_or(ERR_NOT_INITIALIZED)
}

#[no_mangle]
pub extern "C" fn fmap_slot_ptr(slot_index: u32) -> u32 {
    with_pager(|pager| {
        let index = slot_index as usize;
        pager
            .slot_range(index)
            .map(|range| unsafe { pager.bytes.as_ptr().add(range.start) as u32 })
            .unwrap_or(0)
    })
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fmap_slot_valid_bytes(slot_index: u32) -> u32 {
    with_pager(|pager| pager.slots.get(slot_index as usize).map(|slot| slot.valid_bytes).unwrap_or(0))
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fmap_slot_pin_count(slot_index: u32) -> u32 {
    with_pager(|pager| pager.slots.get(slot_index as usize).map(|slot| slot.pin_count).unwrap_or(0))
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fmap_slot_page(slot_index: u32) -> u64 {
    with_pager(|pager| {
        pager
            .slots
            .get(slot_index as usize)
            .filter(|slot| slot.occupied)
            .map(|slot| slot.page_index)
            .unwrap_or(u64::MAX)
    })
    .unwrap_or(u64::MAX)
}

#[no_mangle]
pub extern "C" fn fmap_output_ptr() -> u32 {
    with_pager(|pager| pager.output.as_ptr() as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fmap_output_capacity_f32() -> u32 {
    with_pager(|pager| pager.output.len() as u32).unwrap_or(0)
}

/// Extract strided little-endian Float32 values from one resident page.
///
/// Results are written to the module-owned bounded output buffer. The returned
/// value is the number of elements, or a negative error code.
#[no_mangle]
pub extern "C" fn fmap_extract_f32_le(
    slot_index: u32,
    byte_offset: u32,
    count: u32,
    stride_bytes: u32,
) -> i32 {
    with_pager_mut(|pager| {
        let index = slot_index as usize;
        let Some(slot) = pager.slots.get(index).copied().filter(|slot| slot.occupied) else {
            return ERR_INVALID_SLOT;
        };
        if count as usize > pager.output.len() || (count > 1 && stride_bytes == 0) {
            return ERR_INVALID_LENGTH;
        }
        let Some(range) = pager.slot_range(index) else {
            return ERR_INVALID_SLOT;
        };
        for out_index in 0..count as usize {
            let Some(stride_offset) = out_index.checked_mul(stride_bytes as usize) else {
                return ERR_OUT_OF_BOUNDS;
            };
            let relative = (byte_offset as usize).checked_add(stride_offset);
            let Some(relative) = relative else {
                return ERR_OUT_OF_BOUNDS;
            };
            let Some(stop) = relative.checked_add(4) else {
                return ERR_OUT_OF_BOUNDS;
            };
            if stop > slot.valid_bytes as usize {
                return ERR_OUT_OF_BOUNDS;
            }
            let base = range.start + relative;
            pager.output[out_index] = f32::from_le_bytes([
                pager.bytes[base],
                pager.bytes[base + 1],
                pager.bytes[base + 2],
                pager.bytes[base + 3],
            ]);
        }
        pager.touch_slot(index);
        count as i32
    })
    .unwrap_or(ERR_NOT_INITIALIZED)
}

#[no_mangle]
pub extern "C" fn fmap_hits() -> u64 {
    with_pager(|pager| pager.hits).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fmap_misses() -> u64 {
    with_pager(|pager| pager.misses).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fmap_evictions() -> u64 {
    with_pager(|pager| pager.evictions).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_test_pager(page_size: u32, slots: u32, test: impl FnOnce()) {
        assert_eq!(fmap_init(page_size, slots), OK);
        test();
        PAGER.with(|cell| *cell.borrow_mut() = None);
    }

    #[test]
    fn evicts_least_recently_used_unpinned_page() {
        with_test_pager(64, 2, || {
            let first = fmap_acquire_page(10);
            let second = fmap_acquire_page(20);
            assert!(first >= 0 && second >= 0);
            assert_eq!(fmap_release_page(first as u32), OK);
            assert_eq!(fmap_release_page(second as u32), OK);
            assert_eq!(fmap_touch_page(first as u32), OK);
            let replacement = fmap_acquire_page(30);
            assert_eq!(replacement, second);
            assert_eq!(fmap_find_page(10), first);
            assert_eq!(fmap_find_page(20), -1);
            assert_eq!(fmap_evictions(), 1);
        });
    }

    #[test]
    fn refuses_to_replace_pinned_pages() {
        with_test_pager(64, 1, || {
            assert_eq!(fmap_acquire_page(1), 0);
            assert_eq!(fmap_acquire_page(2), ERR_ALL_PINNED);
            assert_eq!(fmap_pinned_bytes(), 64);
        });
    }

    #[test]
    fn reset_invalidates_slots_and_advances_generation() {
        with_test_pager(64, 1, || {
            assert_eq!(fmap_acquire_page(u64::MAX - 2), 0);
            let generation = fmap_generation();
            assert_eq!(fmap_reset(), OK);
            assert_ne!(fmap_generation(), generation);
            assert_eq!(fmap_find_page(u64::MAX - 2), -1);
            assert_eq!(fmap_pinned_bytes(), 0);
        });
    }

    #[test]
    fn extracts_strided_little_endian_float32_values() {
        with_test_pager(64, 1, || {
            let slot = fmap_acquire_page(7) as u32;
            PAGER.with(|cell| {
                let mut borrow = cell.borrow_mut();
                let pager = borrow.as_mut().unwrap();
                for (index, value) in [1.25_f32, 99.0, -3.5, 100.0].iter().enumerate() {
                    let start = index * 4;
                    pager.bytes[start..start + 4].copy_from_slice(&value.to_le_bytes());
                }
            });
            assert_eq!(fmap_commit_page(slot, 16), OK);
            assert_eq!(fmap_extract_f32_le(slot, 0, 2, 8), 2);
            PAGER.with(|cell| {
                let borrow = cell.borrow();
                assert_eq!(&borrow.as_ref().unwrap().output[..2], &[1.25, -3.5]);
            });
        });
    }

    #[test]
    fn validates_configuration_and_exact_page_lengths() {
        assert_eq!(fmap_init(0, 1), ERR_INVALID_CONFIG);
        with_test_pager(32, 1, || {
            let slot = fmap_acquire_page(0) as u32;
            assert_eq!(fmap_commit_page(slot, 33), ERR_INVALID_LENGTH);
            assert_eq!(fmap_commit_page(slot, 31), OK);
            assert_eq!(fmap_extract_f32_le(slot, 28, 1, 4), ERR_OUT_OF_BOUNDS);
        });
    }
}
