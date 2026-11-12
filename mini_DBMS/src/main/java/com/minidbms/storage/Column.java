package com.minidbms.storage;

import java.util.Objects;

public record Column(String name, ColumnType type) {
    public Column {
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(type, "type");
    }
}
