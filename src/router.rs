use std::collections::HashMap;

pub type RouteId = u32;

pub struct RouteTable {
    by_path: HashMap<String, RouteId>,
    paths_in_order: Vec<String>,
}

impl RouteTable {
    pub fn from_paths(paths: Vec<String>) -> Self {
        let mut by_path = HashMap::with_capacity(paths.len());
        for (id, path) in paths.iter().enumerate() {
            by_path.insert(path.clone(), id as RouteId);
        }
        Self { by_path, paths_in_order: paths }
    }

    pub fn match_path(&self, path: &str) -> Option<RouteId> {
        self.by_path.get(path).copied()
    }

    pub fn paths(&self) -> &[String] {
        &self.paths_in_order
    }
}
