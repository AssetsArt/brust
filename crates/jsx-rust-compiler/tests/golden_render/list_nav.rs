#[path = "../../fixtures/list_nav.expected.rs"]
#[rustfmt::skip]
mod fixture;

use fixture::{ItemsItem, Props};
use pretty_assertions::assert_eq;

#[test]
fn renders_expected_html() {
    let props = Props {
        items: vec![
            ItemsItem {
                href: "/a".into(),
                label: "Alpha".into(),
            },
            ItemsItem {
                href: "/b".into(),
                label: "Beta".into(),
            },
        ],
    };
    let actual = fixture::render(&props).into_string();
    let expected = include_str!("../../fixtures/list_nav.expected.html");
    assert_eq!(actual, expected.trim_end_matches('\n'));
}
