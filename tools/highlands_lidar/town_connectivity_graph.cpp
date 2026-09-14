// Build the portable one-foot conditional-connectivity graph used by the
// floodmapper catalogs. The input DEM must already contain any site-specific
// bulkheads or terrain corrections. No town-specific crest is invented here.

#include "gdal_priv.h"
#include "cpl_conv.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;

constexpr int16_t NODATA_ELEV = std::numeric_limits<int16_t>::min();
constexpr int16_t NO_CONNECTION = std::numeric_limits<int16_t>::max();
constexpr int16_t MODEL_MAX10 = 200;
constexpr int32_t SOURCE_MIN_CELLS = 101;

struct Inputs {
  fs::path dem;
  fs::path developed;
  fs::path output;
  fs::path hard;
};

struct RasterInfo {
  int width = 0;
  int height = 0;
  std::array<double, 6> transform{};
  std::string projection;
};

struct SourceResult {
  std::vector<uint8_t> mask;
  uint64_t component_count = 0;
  uint64_t cell_count = 0;
};

Inputs parse_args(int argc, char** argv) {
  Inputs result;
  for (int i = 1; i < argc; ++i) {
    const std::string key = argv[i];
    if (i + 1 >= argc) throw std::runtime_error("Missing value for " + key);
    const fs::path value = argv[++i];
    if (key == "--dem") result.dem = value;
    else if (key == "--developed") result.developed = value;
    else if (key == "--output") result.output = value;
    else if (key == "--hard") result.hard = value;
    else throw std::runtime_error("Unknown argument: " + key);
  }
  if (result.dem.empty() || result.developed.empty() || result.output.empty()) {
    throw std::runtime_error(
        "Usage: town_connectivity_graph --dem DEM --developed MASK "
        "[--hard MASK] --output DIRECTORY");
  }
  return result;
}

GDALDataset* open_raster(const fs::path& path) {
  auto* ds = static_cast<GDALDataset*>(GDALOpen(path.string().c_str(), GA_ReadOnly));
  if (!ds) throw std::runtime_error("Could not open " + path.string());
  return ds;
}

RasterInfo read_dem(
    const fs::path& path,
    std::vector<int16_t>& elevation10,
    std::vector<uint8_t>& source_eligible) {
  GDALDataset* ds = open_raster(path);
  RasterInfo info;
  info.width = ds->GetRasterXSize();
  info.height = ds->GetRasterYSize();
  if (ds->GetGeoTransform(info.transform.data()) != CE_None)
    throw std::runtime_error("DEM has no geotransform");
  info.projection = ds->GetProjectionRef();
  const size_t count = static_cast<size_t>(info.width) * info.height;
  std::vector<float> input(count);
  GDALRasterBand* band = ds->GetRasterBand(1);
  int has_nodata = 0;
  const double nodata = band->GetNoDataValue(&has_nodata);
  if (band->RasterIO(GF_Read, 0, 0, info.width, info.height, input.data(),
                     info.width, info.height, GDT_Float32, 0, 0) != CE_None)
    throw std::runtime_error("Could not read DEM");
  GDALClose(ds);
  elevation10.assign(count, NODATA_ELEV);
  source_eligible.assign(count, 0);
  uint64_t valid = 0;
  for (size_t i = 0; i < count; ++i) {
    const float value = input[i];
    if (!std::isfinite(value) ||
        (has_nodata && value == static_cast<float>(nodata))) continue;
    elevation10[i] = static_cast<int16_t>(std::clamp(
        static_cast<int>(std::lround(value * 10.0f)), -300, 300));
    source_eligible[i] = value <= 2.0000001f;
    ++valid;
  }
  input.clear(); input.shrink_to_fit();
  std::cout << "Loaded " << valid << " valid one-foot DEM cells\n";
  return info;
}

std::vector<uint8_t> read_mask(const fs::path& path, const RasterInfo& info) {
  GDALDataset* ds = open_raster(path);
  if (ds->GetRasterXSize() != info.width || ds->GetRasterYSize() != info.height)
    throw std::runtime_error("Mask dimensions do not match DEM: " + path.string());
  const size_t count = static_cast<size_t>(info.width) * info.height;
  std::vector<uint8_t> values(count);
  if (ds->GetRasterBand(1)->RasterIO(GF_Read, 0, 0, info.width, info.height,
      values.data(), info.width, info.height, GDT_Byte, 0, 0) != CE_None)
    throw std::runtime_error("Could not read mask " + path.string());
  GDALClose(ds);
  for (auto& value : values) value = value ? 1 : 0;
  return values;
}

SourceResult find_sources(
    const std::vector<uint8_t>& eligible, int width, int height) {
  const size_t count = eligible.size();
  std::vector<uint8_t> state(count, 0);
  std::vector<int32_t> component;
  uint64_t components = 0, cells = 0;
  for (int32_t seed = 0; seed < static_cast<int32_t>(count); ++seed) {
    if (!eligible[seed] || state[seed]) continue;
    component.clear();
    component.push_back(seed);
    state[seed] = 1;
    for (size_t cursor = 0; cursor < component.size(); ++cursor) {
      const int32_t p = component[cursor];
      const int x = p % width, y = p / width;
      const std::array<int32_t, 4> neighbours = {
        x ? p - 1 : -1, x + 1 < width ? p + 1 : -1,
        y ? p - width : -1, y + 1 < height ? p + width : -1};
      for (const int32_t n : neighbours) {
        if (n >= 0 && eligible[n] && !state[n]) {
          state[n] = 1;
          component.push_back(n);
        }
      }
    }
    if (component.size() >= SOURCE_MIN_CELLS) {
      ++components;
      cells += component.size();
      for (const int32_t p : component) state[p] = 2;
    }
  }
  for (auto& value : state) value = value == 2;
  std::cout << "Qualified " << components << " source components (" << cells
            << " cells)\n";
  return {std::move(state), components, cells};
}

std::vector<int16_t> build_connection(
    const std::vector<int16_t>& elevation10,
    const std::vector<uint8_t>& source, int width, int height) {
  int minimum = MODEL_MAX10;
  for (size_t i = 0; i < elevation10.size(); ++i)
    if (source[i]) minimum = std::min(minimum, static_cast<int>(elevation10[i]));
  if (minimum > MODEL_MAX10) throw std::runtime_error("No qualified source cells");
  std::vector<std::vector<int32_t>> buckets(MODEL_MAX10 - minimum + 1);
  std::vector<int16_t> connection(elevation10.size(), NO_CONNECTION);
  for (int32_t i = 0; i < static_cast<int32_t>(elevation10.size()); ++i) {
    if (!source[i]) continue;
    const int stage = std::clamp(static_cast<int>(elevation10[i]), minimum,
                                 static_cast<int>(MODEL_MAX10));
    connection[i] = static_cast<int16_t>(stage);
    buckets[stage - minimum].push_back(i);
  }
  uint64_t connected = 0;
  for (int stage = minimum; stage <= MODEL_MAX10; ++stage) {
    auto& bucket = buckets[stage - minimum];
    for (size_t cursor = 0; cursor < bucket.size(); ++cursor) {
      const int32_t p = bucket[cursor];
      if (connection[p] != stage) continue;
      ++connected;
      const int x = p % width, y = p / width;
      const std::array<int32_t, 4> neighbours = {
        x ? p - 1 : -1, x + 1 < width ? p + 1 : -1,
        y ? p - width : -1, y + 1 < height ? p + width : -1};
      for (const int32_t n : neighbours) {
        if (n < 0 || connection[n] != NO_CONNECTION ||
            elevation10[n] == NODATA_ELEV) continue;
        const int candidate = std::max(stage, static_cast<int>(elevation10[n]));
        if (candidate > MODEL_MAX10) continue;
        connection[n] = static_cast<int16_t>(candidate);
        buckets[candidate - minimum].push_back(n);
      }
    }
    if ((stage - minimum) % 10 == 0 || stage == MODEL_MAX10)
      std::cout << "Connected terrain through " << stage / 10.0 << " ft\n";
  }
  std::cout << "Assigned first-connection stages to " << connected << " cells\n";
  return connection;
}

template <typename T>
void write_raw(const fs::path& path, const std::vector<T>& values) {
  std::ofstream stream(path, std::ios::binary);
  if (!stream) throw std::runtime_error("Could not create " + path.string());
  stream.write(reinterpret_cast<const char*>(values.data()),
               static_cast<std::streamsize>(values.size() * sizeof(T)));
}

void write_manifest(const fs::path& path, const RasterInfo& info,
                    uint64_t hard_cells, const SourceResult& sources,
                    uint64_t connected_cells) {
  std::ofstream out(path);
  out << "{\n"
      << "  \"schema\": \"portable-one-foot-conditional-connectivity-graph-v1\",\n"
      << "  \"width\": " << info.width << ",\n"
      << "  \"height\": " << info.height << ",\n"
      << "  \"cellSizeFt\": 1,\n"
      << "  \"sourceStageNavd88Ft\": 2.0,\n"
      << "  \"sourceMinComponentCells\": 101,\n"
      << "  \"qualifiedSourceComponentCount\": " << sources.component_count << ",\n"
      << "  \"qualifiedSourceCellCount\": " << sources.cell_count << ",\n"
      << "  \"sourceConnectivity\": \"four-neighbour/shared-side only\",\n"
      << "  \"connectionMethod\": \"multi-source minimax path; lowest controlling crest\",\n"
      << "  \"modelMaximumNavd88Ft\": 20.0,\n"
      << "  \"connectedCellCount\": " << connected_cells << ",\n"
      << "  \"bulkheadPixelCount\": " << hard_cells << ",\n"
      << "  \"bulkheadTerrainTreatment\": \"only supplied site-specific conditioned terrain; no borrowed crest\",\n"
      << "  \"geotransform\": [";
  for (size_t i = 0; i < info.transform.size(); ++i) {
    if (i) out << ", ";
    out << info.transform[i];
  }
  out << "]\n}\n";
}

int main(int argc, char** argv) {
  try {
    GDALAllRegister();
    const Inputs inputs = parse_args(argc, argv);
    fs::create_directories(inputs.output);
    std::vector<int16_t> elevation10;
    std::vector<uint8_t> eligible;
    const RasterInfo info = read_dem(inputs.dem, elevation10, eligible);
    if (info.width % 5 || info.height % 5)
      throw std::runtime_error("One-foot grid dimensions must be divisible by five");
    std::vector<uint8_t> developed = read_mask(inputs.developed, info);
    std::vector<uint8_t> hard(elevation10.size(), 0);
    if (!inputs.hard.empty()) hard = read_mask(inputs.hard, info);
    const uint64_t hard_cells = std::count(hard.begin(), hard.end(), uint8_t{1});
    SourceResult sources = find_sources(eligible, info.width, info.height);
    std::vector<uint8_t>& source = sources.mask;
    eligible.clear(); eligible.shrink_to_fit();
    std::vector<int16_t> connection = build_connection(
        elevation10, source, info.width, info.height);
    write_raw(inputs.output / "elevation10.raw", elevation10);
    write_raw(inputs.output / "connection10.raw", connection);
    write_raw(inputs.output / "source_flag.raw", source);
    write_raw(inputs.output / "developed_flag.raw", developed);
    write_raw(inputs.output / "hard_flag.raw", hard);
    const uint64_t connected_cells = std::count_if(
        connection.begin(), connection.end(),
        [](int16_t value) { return value != NO_CONNECTION; });
    write_manifest(inputs.output / "graph_manifest.json", info, hard_cells,
                   sources, connected_cells);
    std::cout << "Portable hydraulic graph complete\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "ERROR: " << error.what() << '\n';
    return 1;
  }
}
