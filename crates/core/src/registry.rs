/// Named, ordered, replaceable rows: the "patch" primitive. A later row with
/// the same name shadows an earlier one.
#[derive(Default)]
pub struct NamedRegistry<T: Send + Sync> {
    rows: Vec<(String, T)>,
}

impl<T: Send + Sync> NamedRegistry<T> {
    pub fn insert(&mut self, name: impl Into<String>, value: T) {
        self.rows.push((name.into(), value));
    }
    pub fn get(&self, name: &str) -> Option<&T> {
        self.rows.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v)
    }
    pub fn iter(&self) -> impl Iterator<Item = &(String, T)> {
        self.rows.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn named_registry_last_wins_and_iterates() {
        let mut reg = NamedRegistry::<u32>::default();
        reg.insert("k", 1u32);
        reg.insert("k", 2u32);
        assert_eq!(*reg.get("k").unwrap(), 2u32);
        assert_eq!(reg.iter().count(), 2);
        assert!(reg.get("missing").is_none());
    }

}
